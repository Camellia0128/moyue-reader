package cn.moyue.reader;

import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.Matrix;
import android.graphics.pdf.PdfRenderer;
import android.os.ParcelFileDescriptor;
import android.util.Base64;
import org.json.JSONObject;
import org.json.JSONArray;
import android.os.Build;
import android.graphics.RectF;
import android.graphics.pdf.content.PdfPageTextContent;
import android.graphics.pdf.models.PageMatchBounds;
import android.graphics.pdf.models.selection.PageSelection;
import android.graphics.pdf.models.selection.SelectionBoundary;
import java.io.*;
import java.util.*;
import java.util.concurrent.ExecutorService;

/** Independent platform PDF fallback; only random session tokens can address its cache. */
final class NativePdfStore {
    interface Reply { void send(JSONObject value); }
    private static final long LIMIT = 100L * 1024 * 1024;
    private static final int KEEP_IMAGES = 4;
    private static final int JPEG_QUALITY = 88;
    private final File root;
    private final ExecutorService executor;
    private final Reply reply;
    private final Map<String, Session> sessions = new HashMap<>();
    private boolean closed;

    /**
     * Sessions are guarded by the registry lock, but rendering is guarded per session: a slow
     * page must never block an image request or another session.
     */
    private static final class Session {
        final Object lock = new Object();
        final Object imageLock = new Object();
        final File file;
        long size;
        PdfRenderer renderer;
        ParcelFileDescriptor descriptor;
        OutputStream out;
        final ArrayDeque<File> images = new ArrayDeque<>();
        final LinkedHashMap<Integer, JSONObject> textCache = new LinkedHashMap<>();
        Session(File file) { this.file = file; }
    }

    NativePdfStore(File cache, ExecutorService executor, Reply reply) {
        root = new File(cache, "pdf-fallback"); root.mkdirs();
        this.executor = executor; this.reply = reply;
        // Stale files are only our own cache files from previous process lifetimes.
        File[] stale = root.listFiles(); if (stale != null) for (File f : stale) if (f.isFile()) f.delete();
    }

    private Session session(String token) throws IOException {
        synchronized (this) {
            Session session = sessions.get(token);
            if (closed || session == null) throw new IOException("PDF 会话已关闭");
            return session;
        }
    }

    private static void closeStream(Session session) {
        if (session.out == null) return;
        try { session.out.flush(); } catch (Exception ignored) {}
        try { session.out.close(); } catch (Exception ignored) {}
        session.out = null;
    }

    synchronized String begin() throws IOException {
        if (closed || sessions.size() >= 4) throw new IOException("PDF 打开任务过多，请先返回书库");
        String token = UUID.randomUUID().toString();
        Session session = new Session(new File(root, token + ".pdf"));
        // One stream for the whole transfer; reopening per 96 KB chunk dominated large files.
        session.out = new BufferedOutputStream(new FileOutputStream(session.file), 1 << 16);
        sessions.put(token, session);
        return token;
    }

    boolean append(String token, String encoded) {
        Session session;
        try { session = session(token); } catch (IOException e) { return false; }
        synchronized (session.lock) {
            if (session.renderer != null || session.out == null || encoded.length() > 200000) return false;
            try {
                byte[] bytes = Base64.decode(encoded, Base64.DEFAULT);
                if (session.size + bytes.length > LIMIT) return false;
                session.out.write(bytes);
                session.size += bytes.length;
                return true;
            } catch (Exception e) { return false; }
        }
    }

    void open(String token, String request) {
        executor.submit(() -> {
            JSONObject result = new JSONObject();
            try {
                Session session = session(token);
                int pages;
                synchronized (session.lock) {
                    try(OutputStream transfer=session.out){session.out=null;if(transfer!=null)transfer.flush();}
                    session.descriptor = ParcelFileDescriptor.open(session.file, ParcelFileDescriptor.MODE_READ_ONLY);
                    try { session.renderer = new PdfRenderer(session.descriptor); }
                    catch (Throwable e) { session.descriptor.close(); session.descriptor = null; throw e; }
                    pages = session.renderer.getPageCount();
                }
                result.put("pages", pages);
                result.put("ok", true);
            } catch (Throwable e) { error(result, e); release(token); }
            finish(request, result);
        });
    }

    void render(String token, int pageIndex, int wantedWidth, int wantedHeight, int rotation, String request) {
        if (!request.matches("[a-f0-9-]{36}")) {
            JSONObject result = new JSONObject();
            error(result, new IOException("PDF 请求标识无效"));
            finish(request, result);
            return;
        }
        executor.submit(() -> {
            JSONObject result = new JSONObject();
            Bitmap bitmap = null;
            try {
                Session session = session(token);
                int pw, ph;
                synchronized (session.lock) {
                    if (session.renderer == null) throw new IOException("PDF 会话已关闭");
                    if (pageIndex < 0 || pageIndex >= session.renderer.getPageCount()) throw new IOException("PDF 页码超出范围");
                    try (PdfRenderer.Page page = session.renderer.openPage(pageIndex)) {
                        int angle = ((rotation % 360) + 360) % 360;
                        if (angle % 90 != 0) angle = 0;
                        boolean swap = angle == 90 || angle == 270;
                        pw = swap ? page.getHeight() : page.getWidth();
                        ph = swap ? page.getWidth() : page.getHeight();
                        if (pw <= 0 || ph <= 0) throw new IOException("PDF 页面尺寸无效");
                        float scale = Math.min(Math.max(64, Math.min(wantedWidth, 6000)) / (float) pw,
                            Math.max(64, Math.min(wantedHeight, 10000)) / (float) ph);
                        scale = Math.min(scale, (float)Math.sqrt(4000000.0 / ((double)pw * ph)));
                        int width = Math.max(1, Math.round(pw * scale)), height = Math.max(1, Math.round(ph * scale));
                        bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888);
                        bitmap.eraseColor(Color.WHITE);
                        Matrix transform = new Matrix();
                        transform.setRotate(angle);
                        if (angle == 90) transform.postTranslate(page.getHeight(), 0);
                        else if (angle == 180) transform.postTranslate(page.getWidth(), page.getHeight());
                        else if (angle == 270) transform.postTranslate(0, page.getWidth());
                        transform.postScale(scale, scale);
                        page.render(bitmap, null, transform, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY);
                        result.put("width", width); result.put("height", height);
                        result.put("pageWidth", pw); result.put("pageHeight", ph);
                    }
                }
                // JPEG encodes several times faster than PNG; the web layer no longer has to
                // round-trip the bitmap through a canvas to freeze it.
                File image = new File(root, token + "-" + request + ".jpg");
                try (OutputStream out = new BufferedOutputStream(new FileOutputStream(image), 1 << 16)) {
                    if (!bitmap.compress(Bitmap.CompressFormat.JPEG, JPEG_QUALITY, out)) throw new IOException("PDF 页面编码失败");
                }
                synchronized (session.imageLock) {
                    session.images.addLast(image);
                    while (session.images.size() > KEEP_IMAGES) session.images.removeFirst().delete();
                }
                result.put("url", "https://reader.moyue.local/native-pdf/" + token + "/" + request + ".jpg");
                result.put("ok", true);
            } catch (Throwable e) { error(result, e); }
            finally { if (bitmap != null) bitmap.recycle(); }
            finish(request, result);
        });
    }

    void text(String token, int pageIndex, boolean positioned, String request) {
        executor.submit(() -> {
            JSONObject result = new JSONObject();
            try {
                Session session = session(token);
                synchronized (session.lock) {
                    if (session.renderer == null) throw new IOException("PDF 会话已关闭");
                    result.put("supported", Build.VERSION.SDK_INT >= 35);
                    JSONArray items = new JSONArray();
                    if (Build.VERSION.SDK_INT >= 35 && positioned && session.textCache.containsKey(pageIndex)) {
                        JSONObject cached = session.textCache.get(pageIndex);items=cached.getJSONArray("items");result.put("width",cached.getInt("width"));result.put("height",cached.getInt("height"));
                    } else if (Build.VERSION.SDK_INT >= 35) {
                        try (PdfRenderer.Page page = session.renderer.openPage(pageIndex)) {
                            result.put("width", page.getWidth()); result.put("height", page.getHeight());
                            List<JSONObject> positionedItems = new ArrayList<>(); Set<Integer> seenStarts = new HashSet<>(); Set<String> seenLines = new HashSet<>(); int lineCount = 0;
                            for (PdfPageTextContent content : page.getTextContents()) {
                                RectF bounds = new RectF();
                                for (RectF rect : content.getBounds()) bounds.union(rect);
                                if (positioned) {
                                    // Some platform builds expose page text without its geometry.
                                    // Search distinct lines to obtain authoritative selection bounds.
                                    for (String line : content.getText().split("\\r?\\n")) {
                                        line = line.trim(); if (line.isEmpty() || !seenLines.add(line) || line.length()>2000) continue;
                                        if (++lineCount > 1000) break;
                                        for (PageMatchBounds match : page.searchText(line)) {
                                            RectF found = new RectF(); for (RectF rect : match.getBounds()) found.union(rect);
                                            if (!found.isEmpty() && seenStarts.add(match.getTextStartIndex())) {JSONObject item=textItem(line,found,page.getWidth(),page.getHeight());item.put("globalStart",match.getTextStartIndex());positionedItems.add(item);}
                                        }
                                    }
                                } else items.put(textItem(content.getText(),bounds,page.getWidth(),page.getHeight()));
                            }
                            if (positioned) {
                                items = canonicalText(page, positionedItems);
                                JSONObject cached=new JSONObject();cached.put("width",page.getWidth());cached.put("height",page.getHeight());cached.put("items",items);session.textCache.put(pageIndex,cached);
                                while(session.textCache.size()>4)session.textCache.remove(session.textCache.keySet().iterator().next());
                            }
                        }
                    }
                    result.put("items", items);
                }
                result.put("ok", true);
            } catch (Throwable e) { error(result, e); }
            finish(request, result);
        });
    }
    /** Search matches can overlap when the same paragraph is wrapped differently in two columns.
     * Build one canonical page selection, then map its individual lines to native character indices. */
    private static JSONArray canonicalText(PdfRenderer.Page page, List<JSONObject> matches) throws Exception {
        if (Build.VERSION.SDK_INT < 35) throw new IOException("当前系统没有原生文字选区接口");
        int end=0;for(JSONObject item:matches)end=Math.max(end,item.getInt("globalStart")+item.getString("str").length());
        JSONArray items=new JSONArray();if(end==0)return items;if(end>200000)throw new IOException("该页文字过多");
        PageSelection whole=page.selectContent(new SelectionBoundary(0),new SelectionBoundary(end));if(whole==null)return items;
        StringBuilder canonical=new StringBuilder();for(PdfPageTextContent content:whole.getSelectedTextContents())canonical.append(content.getText());
        int previousEnd=0,count=0;
        for(String raw:canonical.toString().split("(?<=\n)")){
            String line=raw.replace("\r","").replace("\n","");int leading=0;while(leading<line.length()&&Character.isWhitespace(line.charAt(leading)))leading++;
            String selectedText=line.substring(leading).trim();
            if(!selectedText.isEmpty()&&++count<=2000){
                PageMatchBounds chosen=null;for(PageMatchBounds match:page.searchText(selectedText))if(match.getTextStartIndex()>=previousEnd&&(chosen==null||match.getTextStartIndex()<chosen.getTextStartIndex()))chosen=match;
                if(chosen!=null){RectF bounds=new RectF();for(RectF rect:chosen.getBounds())bounds.union(rect);if(!bounds.isEmpty()){JSONObject item=textItem(selectedText,bounds,page.getWidth(),page.getHeight());item.put("globalStart",chosen.getTextStartIndex());items.put(item);previousEnd=chosen.getTextStartIndex()+selectedText.length();}}
            }
        }
        return items;
    }
    void selection(String token, int pageIndex, int start, int end, String request) {
        executor.submit(() -> {
            JSONObject result = new JSONObject();
            try {
                if (Build.VERSION.SDK_INT < 35 || start < 0 || end <= start || end > 1000000) throw new IOException("当前系统无法精确调整这个文字范围");
                Session session = session(token);
                synchronized (session.lock) {
                    if (session.renderer == null) throw new IOException("PDF 会话已关闭");
                    try (PdfRenderer.Page page = session.renderer.openPage(pageIndex)) {
                        PageSelection selected = page.selectContent(new SelectionBoundary(start), new SelectionBoundary(end));
                        if (selected == null) throw new IOException("该范围没有可选文字");
                        JSONArray rects = new JSONArray(); StringBuilder text = new StringBuilder();
                        for (PdfPageTextContent content : selected.getSelectedTextContents()) {
                            text.append(content.getText());
                            for (RectF r : content.getBounds()) {
                                JSONObject b = new JSONObject(); b.put("x", r.left / page.getWidth()); b.put("y", r.top / page.getHeight()); b.put("w", r.width() / page.getWidth()); b.put("h", r.height() / page.getHeight()); rects.put(b);
                            }
                        }
                        if (rects.length() == 0) throw new IOException("系统未提供这个范围的准确位置");
                        result.put("text", text.toString()); result.put("rects", rects);
                    }
                }
                result.put("ok", true);
            } catch (Throwable e) { error(result, e); }
            finish(request, result);
        });
    }
    private static JSONObject textItem(String text, RectF bounds, int width, int height) throws org.json.JSONException {
        JSONObject item=new JSONObject();item.put("str",text);item.put("x",bounds.left/width);item.put("y",bounds.top/height);item.put("w",bounds.width()/width);item.put("h",bounds.height()/height);return item;
    }
    InputStream image(String token, String name) throws IOException {
        Session session = session(token);
        if (!name.matches("[a-f0-9-]{36}\\.jpg")) throw new FileNotFoundException();
        File file = new File(root, token + "-" + name);
        synchronized (session.imageLock) {
            if (!session.images.contains(file)) throw new FileNotFoundException();
            return new FileInputStream(file);
        }
    }
    void release(String token) {
        Session session;
        synchronized (this) { session = sessions.remove(token); }
        if (session == null) return;
        synchronized (session.lock) {
            closeStream(session);
            try { if (session.renderer != null) session.renderer.close(); } catch (Throwable ignored) {}
            try { if (session.descriptor != null) session.descriptor.close(); } catch (Throwable ignored) {}
            session.renderer = null; session.descriptor = null;
            session.file.delete();
            synchronized(session.imageLock){for (File image : session.images) image.delete();session.images.clear();}
        }
    }
    void close() {
        List<String> tokens;
        synchronized (this) { closed = true; tokens = new ArrayList<>(sessions.keySet()); }
        for (String token : tokens) release(token);
    }
    private void finish(String request, JSONObject result) {
        try { result.put("request", request); } catch (Exception ignored) {}
        reply.send(result);
    }
    private static void error(JSONObject result, Throwable e) {
        try {
            result.put("ok", false);
            result.put("message", e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage());
        } catch (Exception ignored) {}
    }
}
