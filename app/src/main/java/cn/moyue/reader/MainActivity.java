package cn.moyue.reader;

import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.database.Cursor;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.OpenableColumns;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.RenderProcessGoneDetail;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.*;

/** Offline reader host. Documents are copied through SAF; no storage or network permission. */
public final class MainActivity extends Activity {
    private static final String HOST = "reader.moyue.local";
    private static final int PICK = 10, EXPORT = 11, FONT = 12, DICT = 13;
    private static final long MAX_BYTES = 100L * 1024 * 1024;
    private static final int MIN_WEBVIEW_MAJOR = 110;
    private static final int IMPORT_LIMIT = 8;
    private static final int FLASH_FRAME_MS = 80;
    private WebView web;
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    /** Keep at most eight active copies, and never evict one before the UI acknowledges it. */
    private final Map<String, File> imports = new ConcurrentHashMap<>();
    private final ArrayDeque<Uri> importQueue = new ArrayDeque<>();
    private int activeImports;
    private volatile boolean destroyed;
    private final List<JSONObject> pending = new ArrayList<>();
    private boolean ready;
    private volatile boolean keyTurns;
    private String exportText;
    private File exportFile;
    private String exportToken;
    private boolean exportPicking;
    private OutputStream exportStream;
    private long exportBytes;
    private View flashView;
    private NativePdfStore nativePdf;
    private File fontDir;

    // Required by the packaged local UI. Only the pinned HTTPS asset origin can load;
    // imported documents are sanitized and remote requests are refused.
    @android.annotation.SuppressLint("SetJavaScriptEnabled")
    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        File[] staleExports = getCacheDir().listFiles();
        if (staleExports != null) for (File file : staleExports) if (file.isFile() && file.getName().matches("(backup|import)-[a-f0-9-]{36}")) file.delete();
        nativePdf = new NativePdfStore(getCacheDir(), io, result -> send("pdf", result));
        fontDir = new File(getFilesDir(), "fonts"); fontDir.mkdirs();
        Integer webViewMajor = currentWebViewMajor();
        if (webViewMajor == null || webViewMajor < MIN_WEBVIEW_MAJOR) {
            showWebViewTooOld(webViewMajor);
            return;
        }
        web = new WebView(this);
        web.setBackgroundColor(0xffdddddd);
        web.getSettings().setJavaScriptEnabled(true);
        web.getSettings().setDomStorageEnabled(true);
        web.getSettings().setAllowFileAccess(false);
        web.getSettings().setAllowContentAccess(false);
        web.getSettings().setMixedContentMode(android.webkit.WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        web.getSettings().setSupportZoom(false);
        web.getSettings().setMediaPlaybackRequiresUserGesture(true);
        // The reader owns its font scale; system text zoom would scale the page twice.
        web.getSettings().setTextZoom(100);
        WebView.setWebContentsDebuggingEnabled((getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0);
        web.addJavascriptInterface(new Bridge(), "Android");
        web.setWebChromeClient(new WebChromeClient());
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                if (view != web) return true;
                ready = false; keyTurns = false;
                getIntent().putExtra("moyue-renderer-recovery", true);
                if (view.getParent() instanceof ViewGroup) ((ViewGroup)view.getParent()).removeView(view);
                web = null; view.destroy();
                new Handler(Looper.getMainLooper()).post(() -> { if (!isFinishing()) recreate(); });
                return true;
            }
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return !HOST.equals(request.getUrl().getHost());
            }
            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (!HOST.equals(uri.getHost()) || !"https".equals(uri.getScheme())) return denied();
                String path = uri.getPath();
                try {
                    if (path != null && path.startsWith("/native-pdf/")) {
                        String[] parts = path.split("/");
                        if (parts.length != 4) return denied();
                        return response("image/jpeg", nativePdf.image(parts[2], parts[3]), null);
                    }
                    if (path != null && path.startsWith("/import/")) {
                        File file = imports.get(path.substring(8));
                        if (file == null) return denied();
                        return response("application/octet-stream", new FileInputStream(file), null);
                    }
                    // Imported typefaces live in app storage; only a random token can address one.
                    if (path != null && path.startsWith("/font/")) {
                        String token = path.substring(6);
                        if (!token.matches("[a-f0-9-]{36}\\.(ttf|otf|ttc)")) return denied();
                        File file = new File(fontDir, token);
                        if (!file.isFile()) return denied();
                        return response(token.endsWith(".otf") ? "font/otf" : "font/ttf", new FileInputStream(file), "public, max-age=31536000, immutable");
                    }
                    if (path == null || path.equals("/")) path = "/index.html";
                    if (path.contains("..") || path.contains("\\")) return denied();
                    return response(mime(path), getAssets().open("web" + path), cacheControl(path));
                } catch (IOException e) { return denied(); }
            }
        });
        setContentView(web);
        setImmersive();
        boolean rendererRecovery = getIntent().getBooleanExtra("moyue-renderer-recovery", false);
        getIntent().removeExtra("moyue-renderer-recovery");
        web.loadUrl("https://" + HOST + "/index.html" + (rendererRecovery ? "?recover=renderer" : ""));
        if (!rendererRecovery) acceptIntent(getIntent());
        if (android.os.Build.VERSION.SDK_INT >= 33) {
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(0, () -> send("back", null));
        }
    }

    /** Null when the WebView package cannot be resolved; both cases are treated as unsupported. */
    private Integer currentWebViewMajor() {
        try {
            PackageInfo info = WebView.getCurrentWebViewPackage();
            if (info == null || info.versionName == null) return null;
            String major = info.versionName.split("\\.")[0].replaceAll("[^0-9]", "");
            return major.isEmpty() ? null : Integer.parseInt(major);
        } catch (Throwable e) {
            return null;
        }
    }

    private void showWebViewTooOld(Integer major) {
        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        layout.setBackgroundColor(0xffdddddd);
        int pad = Math.round(32 * getResources().getDisplayMetrics().density);
        layout.setPadding(pad, pad, pad, pad);
        layout.setGravity(android.view.Gravity.CENTER_VERTICAL);
        TextView title = new TextView(this);
        title.setText("需要更新系统 WebView");
        title.setTextSize(22);
        title.setTextColor(0xff202020);
        TextView body = new TextView(this);
        body.setText("墨阅的阅读界面需要 Android System WebView " + MIN_WEBVIEW_MAJOR
            + " 或更新版本。\n\n当前版本：" + (major == null ? "无法读取" : major + ".x")
            + "\n\n请打开应用商店，更新「Android System WebView」或「Chrome」后重新启动墨阅。\n\n已导入的书籍和笔记仍保存在本机，更新 WebView 后即可正常打开。");
        body.setTextSize(15);
        body.setTextColor(0xff383838);
        body.setLineSpacing(8, 1f);
        LinearLayout.LayoutParams gap = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        gap.topMargin = pad / 2;
        layout.addView(title);
        layout.addView(body, gap);
        setContentView(layout);
    }

    private static String mime(String path) {
        if (path.endsWith(".html")) return "text/html";
        if (path.endsWith(".js") || path.endsWith(".mjs")) return "text/javascript";
        if (path.endsWith(".css")) return "text/css";
        if (path.endsWith(".json")) return "application/json";
        if (path.endsWith(".svg")) return "image/svg+xml";
        if (path.endsWith(".png")) return "image/png";
        if (path.endsWith(".jpg") || path.endsWith(".jpeg")) return "image/jpeg";
        if (path.endsWith(".woff2")) return "font/woff2";
        if (path.endsWith(".woff")) return "font/woff";
        if (path.endsWith(".bcmap")) return "application/octet-stream";
        if (path.endsWith(".pdf")) return "application/pdf";
        if (path.endsWith(".wasm")) return "application/wasm";
        if (path.endsWith(".txt")) return "text/plain";
        return "application/octet-stream";
    }

    /**
     * Hashed build output never changes inside one APK, so it can stay in the WebView cache.
     * Entry points keep their names across builds and must be revalidated on every launch.
     */
    private static String cacheControl(String path) {
        if ((path.startsWith("/chunks/") || path.startsWith("/fonts/"))
            && path.matches(".*/[^/]+-[A-Z0-9]{8}\\.(m?js|css|woff2)")) {
            return "public, max-age=31536000, immutable";
        }
        return "no-cache";
    }

    private WebResourceResponse response(String type, InputStream stream, String cacheControl) {
        Map<String, String> headers = new HashMap<>();
        headers.put("Cache-Control", cacheControl == null ? "no-cache" : cacheControl);
        headers.put("X-Content-Type-Options", "nosniff");
        long length = -1;
        try {
            if (stream instanceof FileInputStream) length = ((FileInputStream) stream).getChannel().size();
        } catch (Exception ignored) { /* Length stays optional; the engine streams without it. */ }
        if (length > 0) headers.put("Content-Length", Long.toString(length));
        return new WebResourceResponse(type, "UTF-8", 200, "OK", headers, stream);
    }
    private static WebResourceResponse denied() {
        return new WebResourceResponse("text/plain", "UTF-8", 404, "Not Found", Collections.emptyMap(), new ByteArrayInputStream(new byte[0]));
    }
    private void setImmersive() {
        getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY | View.SYSTEM_UI_FLAG_FULLSCREEN
            | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_LAYOUT_STABLE | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
            | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
    }
    private void send(String type, Object value) {
        runOnUiThread(() -> {
            if (web == null) return;
            String json = value == null ? "null" : value.toString();
            web.evaluateJavascript("window.NativeEvents&&window.NativeEvents(" + JSONObject.quote(type) + "," + json + ")", null);
        });
    }
    /** StarDict bundles need several files at once; no MIME filter can express that. */
    private void pickDictionary() {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.setType("*/*");
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        try { startActivityForResult(intent, DICT); }
        catch (Exception e) { Toast.makeText(this, "未找到文件选择器", Toast.LENGTH_LONG).show(); }
    }

    /** Copies every selected dictionary part, then reports them as one bundle. */
    private void importDictBatch(List<Uri> uris) {
        io.submit(() -> {
            JSONArray items = new JSONArray();
            List<File> copied = new ArrayList<>();
            try {
                for (Uri uri : uris) {
                    String name = "dictionary";
                    try (Cursor cursor = getContentResolver().query(uri, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
                        if (cursor != null && cursor.moveToFirst() && !cursor.isNull(0) && !cursor.getString(0).trim().isEmpty()) name = cursor.getString(0);
                    }
                    String token = UUID.randomUUID().toString();
                    File out = new File(getCacheDir(), "import-" + token);
                    copied.add(out);
                    long total = 0;
                    try (InputStream input = getContentResolver().openInputStream(uri); OutputStream output = new FileOutputStream(out)) {
                        if (input == null) throw new IOException("无法读取 " + name);
                        byte[] buffer = new byte[65536]; int count;
                        while ((count = input.read(buffer)) != -1) {
                            total += count;
                            if (total > 200L * 1024 * 1024) throw new IOException(name + " 超过 200 MB");
                            output.write(buffer, 0, count);
                        }
                    }
                    imports.put(token, out);
                    JSONObject item = new JSONObject();
                    item.put("name", name); item.put("token", token); item.put("size", total);
                    item.put("url", "https://" + HOST + "/import/" + token);
                    items.put(item);
                }
                send("dictfiles", items);
            } catch (Exception e) {
                for (File file : copied) file.delete();
                try { for (int i = 0; i < items.length(); i++) imports.remove(items.getJSONObject(i).optString("token")); } catch (Exception ignored) {}
                send("error", JSONObject.quote("导入词典失败：" + e.getMessage()));
            }
        });
    }

    private void pickFont() {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.setType("*/*");
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.putExtra(Intent.EXTRA_MIME_TYPES, new String[]{
            "font/ttf", "font/otf", "font/ttc", "font/sfnt",
            "application/x-font-ttf", "application/x-font-opentype", "application/octet-stream"});
        try { startActivityForResult(intent, FONT); }
        catch (Exception e) { Toast.makeText(this, "未找到文件选择器", Toast.LENGTH_LONG).show(); }
    }

    /** Imported typefaces stay in app storage; only the resulting token is exposed to the page. */
    private void importFont(Uri uri) {
        io.submit(() -> {
            File temp = null;
            try {
                String name = "导入字体";
                try (Cursor cursor = getContentResolver().query(uri, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
                    if (cursor != null && cursor.moveToFirst() && !cursor.isNull(0) && !cursor.getString(0).trim().isEmpty()) name = cursor.getString(0);
                }
                temp = new File(getCacheDir(), "font-" + UUID.randomUUID());
                long total = 0;
                try (InputStream input = getContentResolver().openInputStream(uri); OutputStream output = new FileOutputStream(temp)) {
                    if (input == null) throw new IOException("无法读取字体文件");
                    byte[] buffer = new byte[65536]; int count;
                    while ((count = input.read(buffer)) != -1) {
                        total += count;
                        if (total > 20L * 1024 * 1024) throw new IOException("字体文件超过 20 MB");
                        output.write(buffer, 0, count);
                    }
                }
                if (total < 12) throw new IOException("字体文件为空或不完整");
                String extension = fontExtension(temp);
                if (extension == null) throw new IOException("这不是有效的 TTF / OTF 字体文件");
                String token = UUID.randomUUID().toString() + "." + extension;
                File destination = new File(fontDir, token);
                if (!temp.renameTo(destination)) {
                    try (InputStream in = new FileInputStream(temp); OutputStream out = new FileOutputStream(destination)) {
                        byte[] buffer = new byte[65536]; int count;
                        while ((count = in.read(buffer)) != -1) out.write(buffer, 0, count);
                    }
                    temp.delete();
                }
                temp = null;
                JSONObject item = new JSONObject();
                item.put("name", name.replaceAll("\\.[^.]+$", ""));
                item.put("url", "https://" + HOST + "/font/" + token);
                send("font", item);
            } catch (Exception e) {
                if (temp != null) temp.delete();
                send("error", JSONObject.quote("导入字体失败：" + e.getMessage()));
            }
        });
    }

    private static String fontExtension(File file) {
        try (InputStream input = new FileInputStream(file)) {
            byte[] head = new byte[4];
            if (input.read(head) != 4) return null;
            if (head[0] == 0 && head[1] == 1 && head[2] == 0 && head[3] == 0) return "ttf";
            String magic = new String(head, StandardCharsets.ISO_8859_1);
            if ("OTTO".equals(magic)) return "otf";
            if ("ttcf".equals(magic)) return "ttc";
            if ("true".equals(magic) || "typ1".equals(magic)) return "ttf";
            return null;
        } catch (IOException e) { return null; }
    }

    private void pick() {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.setType("*/*");
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        intent.putExtra(Intent.EXTRA_MIME_TYPES, new String[]{
            "application/pdf", "application/epub+zip", "application/msword",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "text/plain", "text/markdown", "text/x-markdown", "text/html",
            "application/zip", "application/octet-stream"});
        try { startActivityForResult(intent, PICK); }
        catch (Exception e) { Toast.makeText(this, "未找到文件选择器", Toast.LENGTH_LONG).show(); }
    }
    private void importUri(Uri uri) {
        if (uri == null) return;
        runOnUiThread(() -> { if (!destroyed) { importQueue.addLast(uri); pumpImports(); } });
    }
    private void pumpImports() {
        while (!destroyed && activeImports < IMPORT_LIMIT && !importQueue.isEmpty()) {
            activeImports++; copyImport(importQueue.removeFirst());
        }
    }
    private void copyImport(Uri uri) {
        io.submit(() -> {
            File out = null;
            try {
                if (destroyed) return;
                String name = "导入文档";
                long size = -1;
                try (Cursor cursor = getContentResolver().query(uri, new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE}, null, null, null)) {
                    if (cursor != null && cursor.moveToFirst()) {
                        if (!cursor.isNull(0) && !cursor.getString(0).trim().isEmpty()) name = cursor.getString(0);
                        if (!cursor.isNull(1)) size = cursor.getLong(1);
                    }
                } catch (Exception ignored) { /* Providers may omit optional display metadata. */ }
                String mediaType = null;
                try { mediaType = getContentResolver().getType(uri); } catch (Exception ignored) {}
                if (!name.matches("(?i).*\\.(pdf|epub|docx|doc|txt|md|html|htm|moyue)$")) {
                    String extension = "application/pdf".equals(mediaType)?".pdf":"application/epub+zip".equals(mediaType)?".epub":"application/msword".equals(mediaType)?".doc":"application/vnd.openxmlformats-officedocument.wordprocessingml.document".equals(mediaType)?".docx":("text/plain".equals(mediaType)||"text/markdown".equals(mediaType)||"text/x-markdown".equals(mediaType))?".txt":"text/html".equals(mediaType)?".html":"";
                    name += extension;
                }
                long importLimit = name.toLowerCase(Locale.ROOT).endsWith(".moyue") ? 1033L * 1024 * 1024 : MAX_BYTES;
                if (size > importLimit) throw new IOException("文档最大 100 MB，书库备份最大 1 GB");
                String token = UUID.randomUUID().toString();
                out = new File(getCacheDir(), "import-" + token);
                long total = 0;
                try (InputStream input = getContentResolver().openInputStream(uri); OutputStream output = new FileOutputStream(out)) {
                    if (input == null) throw new IOException("无法读取该文件");
                    byte[] buffer = new byte[65536];
                    int count;
                    while ((count = input.read(buffer)) != -1) {
                        total += count;
                        if (total > importLimit) throw new IOException("文件超过导入大小限制");
                        output.write(buffer, 0, count);
                    }
                }
                if (!name.matches("(?i).*\\.(pdf|epub|docx|doc|txt|md|html|htm|moyue)$")) {
                    byte[] header = new byte[1024];
                    try (InputStream input = new FileInputStream(out)) {
                        int count = input.read(header);
                        if (count > 0 && new String(header,0,count,StandardCharsets.ISO_8859_1).contains("%PDF-")) name += ".pdf";
                    }
                }
                imports.put(token, out);
                JSONObject item = new JSONObject();
                item.put("name", name); item.put("size", total); item.put("token", token);
                item.put("url", "https://" + HOST + "/import/" + token);
                runOnUiThread(() -> {
                    if (destroyed) { File file=imports.remove(token);if(file!=null)file.delete();return; }
                    if (ready) send("files", new JSONArray().put(item));
                    else pending.add(item);
                });
            } catch (Exception e) {
                if (out != null) out.delete();
                send("error", JSONObject.quote("导入失败：" + e.getMessage()));
                runOnUiThread(() -> {activeImports--;pumpImports();});
            }
        });
    }
    private void acceptIntent(Intent intent) {
        if (intent == null) return;
        if (Intent.ACTION_VIEW.equals(intent.getAction()) && intent.getData() != null) importUri(intent.getData());
        if (Intent.ACTION_SEND.equals(intent.getAction())) {
            Uri uri = intent.getParcelableExtra(Intent.EXTRA_STREAM);
            if (uri != null) importUri(uri);
        }
    }
    @Override protected void onNewIntent(Intent intent) { super.onNewIntent(intent); setIntent(intent); acceptIntent(intent); }
    @Override protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (result != RESULT_OK || data == null || request == EXPORT && data.getData() == null) { if (request == EXPORT) {exportText = null;clearExport();} return; }
        if (request == PICK) {
            if (data.getClipData() != null) {
                int n = data.getClipData().getItemCount();
                for (int i = 0; i < n; i++) importUri(data.getClipData().getItemAt(i).getUri());
            } else if (data.getData() != null) importUri(data.getData());
        } else if (request == FONT && data.getData() != null) {
            importFont(data.getData());
        } else if (request == DICT) {
            List<Uri> uris = new ArrayList<>();
            if (data.getClipData() != null) { for (int i = 0; i < data.getClipData().getItemCount(); i++) uris.add(data.getClipData().getItemAt(i).getUri()); }
            else if (data.getData() != null) uris.add(data.getData());
            if (!uris.isEmpty()) importDictBatch(uris);
        } else if (request == EXPORT && exportFile != null && data.getData() != null) {
            final File source = exportFile; final Uri uri = data.getData();
            io.submit(() -> {
                try (InputStream input = new FileInputStream(source); OutputStream output = getContentResolver().openOutputStream(uri, "wt")) {
                    if (output == null) throw new IOException("无法写入目标位置");
                    byte[] buffer = new byte[65536]; int count;
                    while ((count = input.read(buffer)) != -1) output.write(buffer, 0, count);
                    send("saved", JSONObject.quote("完整书库备份已保存"));
                } catch (Exception e) { send("error", JSONObject.quote("备份保存失败：" + e.getMessage())); }
                finally { clearExport(); }
            });
        } else if (request == EXPORT && exportText != null && data.getData() != null) {
            String text = exportText; exportText = null; Uri uri = data.getData();
            io.submit(() -> {
                try (OutputStream out = getContentResolver().openOutputStream(uri, "wt")) {
                    if (out == null) throw new IOException("无法写入目标位置");
                    out.write(text.getBytes(StandardCharsets.UTF_8));
                    send("saved", JSONObject.quote("已保存到所选位置"));
                } catch (Exception e) { send("error", JSONObject.quote("保存失败：" + e.getMessage())); }
            });
        }
    }
    private synchronized void clearExport() {
        closeQuietly(exportStream); exportStream = null; exportBytes = 0;
        if (exportFile != null) exportFile.delete(); exportFile = null; exportToken = null; exportPicking = false;
    }
    private static void closeQuietly(Closeable stream) {
        if (stream == null) return;
        if (stream instanceof Flushable) { try { ((Flushable) stream).flush(); } catch (Exception ignored) {} }
        try { stream.close(); } catch (Exception ignored) {}
    }
    @Override public void onBackPressed() { if(web==null)finish();else send("back", null); }
    @Override public boolean onKeyDown(int code, KeyEvent event) {
        if (keyTurns && (code == KeyEvent.KEYCODE_VOLUME_DOWN || code == KeyEvent.KEYCODE_VOLUME_UP || code == KeyEvent.KEYCODE_PAGE_DOWN || code == KeyEvent.KEYCODE_PAGE_UP)) {
            send("key", JSONObject.quote((code == KeyEvent.KEYCODE_VOLUME_DOWN || code == KeyEvent.KEYCODE_PAGE_DOWN) ? "next" : "prev"));
            return true;
        }
        return super.onKeyDown(code, event);
    }
    @Override public void onWindowFocusChanged(boolean focus) { super.onWindowFocusChanged(focus); if(focus) setImmersive(); }
    @Override protected void onPause() { if(web != null) web.evaluateJavascript("window.ReaderApp&&window.ReaderApp.flush()", null); super.onPause(); }
    @Override protected void onDestroy() {
        destroyed=true;importQueue.clear();
        if(nativePdf!=null)io.submit(nativePdf::close);
        io.shutdown();
        clearExport();
        if(flashView!=null){ if(flashView.getParent() instanceof ViewGroup) ((ViewGroup)flashView.getParent()).removeView(flashView); flashView=null; }
        if(web != null) {web.removeJavascriptInterface("Android");web.destroy();web=null;}
        super.onDestroy();
    }

    /** Visual refresh simulation only. A black/white overlay cannot select a hardware waveform. */
    private void flashRefresh() {
        if (web == null || flashView != null) return;
        ViewGroup root = findViewById(android.R.id.content);
        if (root == null) return;
        final View frame = new View(this);
        frame.setBackgroundColor(Color.rgb(18, 18, 18));
        flashView = frame;
        root.addView(frame, new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        Handler handler = new Handler(Looper.getMainLooper());
        handler.postDelayed(() -> {
            if (flashView != frame) return;
            frame.setBackgroundColor(Color.rgb(242, 242, 242));
            handler.postDelayed(() -> {
                if (flashView != frame) return;
                root.removeView(frame);
                flashView = null;
            }, FLASH_FRAME_MS);
        }, FLASH_FRAME_MS);
    }

    public final class Bridge {
        @JavascriptInterface public String beginExport() {
            synchronized (MainActivity.this) {
                if (exportFile != null || exportText != null || exportStream != null) return "";
                try {
                    exportToken = UUID.randomUUID().toString();
                    exportFile = new File(getCacheDir(), "backup-" + exportToken);
                    // One stream for the whole transfer. A 1 GB backup used to reopen the file
                    // once per 96 KB chunk, which dominated the export time.
                    exportStream = new BufferedOutputStream(new FileOutputStream(exportFile), 1 << 16);
                    exportBytes = 0;
                    return exportToken;
                } catch (IOException e) { clearExport(); return ""; }
            }
        }
        @JavascriptInterface public boolean appendExport(String token, String encoded) {
            synchronized (MainActivity.this) {
                if (!Objects.equals(token,exportToken) || exportStream == null || exportFile == null || exportPicking || encoded.length()>200000) return false;
                try {
                    byte[] bytes=android.util.Base64.decode(encoded,android.util.Base64.DEFAULT);
                    if(exportBytes+bytes.length>1033L*1024*1024) return false;
                    exportStream.write(bytes);
                    exportBytes+=bytes.length;
                    return true;
                } catch(Exception e){return false;}
            }
        }
        @JavascriptInterface public void cancelExport(String token) { synchronized(MainActivity.this){if(Objects.equals(token,exportToken)&&!exportPicking)clearExport();} }
        @JavascriptInterface public void finishExport(String token, String name) {
            synchronized(MainActivity.this){
                if(!Objects.equals(token,exportToken)||exportFile==null||exportPicking)return;
                try { if(exportStream!=null){exportStream.flush();exportStream.close();exportStream=null;} }
                catch(IOException e){clearExport();send("error",JSONObject.quote("备份缓存保存失败："+e.getMessage()));return;}
                exportPicking=true;
            }
            runOnUiThread(()->{try{Intent i=new Intent(Intent.ACTION_CREATE_DOCUMENT);i.addCategory(Intent.CATEGORY_OPENABLE);i.setType("application/octet-stream");i.putExtra(Intent.EXTRA_TITLE,name.replaceAll("[\\\\/:*?\"<>|]","_"));startActivityForResult(i,EXPORT);}catch(Exception e){clearExport();send("error",JSONObject.quote("未找到可用的文件保存位置"));}});
        }
        @JavascriptInterface public String beginPdf() { try { return nativePdf.begin(); } catch (Exception e) { return ""; } }
        @JavascriptInterface public boolean appendPdf(String token, String bytes) { return nativePdf.append(token, bytes); }
        @JavascriptInterface public void openPdf(String token, String request) { nativePdf.open(token, request); }
        @JavascriptInterface public void renderPdf(String token, int page, int width, int height, int rotation, String request) { nativePdf.render(token, page, width, height, rotation, request); }
        @JavascriptInterface public void pdfText(String token, int page, boolean positioned, String request) { nativePdf.text(token, page, positioned, request); }
        @JavascriptInterface public void pdfSelection(String token, int page, int start, int end, String request) { nativePdf.selection(token, page, start, end, request); }
        @JavascriptInterface public void releasePdf(String token) { io.submit(() -> nativePdf.release(token)); }
        @JavascriptInterface public void ready() { runOnUiThread(() -> {ready = true; if(!pending.isEmpty()){JSONArray list=new JSONArray();for(JSONObject o:pending)list.put(o);pending.clear();send("files",list);}}); }
        @JavascriptInterface public void pickFiles() { runOnUiThread(MainActivity.this::pick); }
        @JavascriptInterface public void pickFont() { runOnUiThread(MainActivity.this::pickFont); }
        @JavascriptInterface public void pickDictionary() { runOnUiThread(MainActivity.this::pickDictionary); }
        @JavascriptInterface public void deleteFont(String token) {
            if (token == null || !token.matches("[a-f0-9-]{36}\\.(ttf|otf|ttc)")) return;
            io.submit(() -> new File(fontDir, token).delete());
        }
        @JavascriptInterface public void releaseImport(String token) { runOnUiThread(() -> {File file=imports.remove(token);if(file!=null){file.delete();activeImports--;pumpImports();}}); }
        @JavascriptInterface public void keepScreenOn(boolean on) { runOnUiThread(() -> {if(on)getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);}); }
        @JavascriptInterface public void setKeyTurns(boolean on) { keyTurns=on; }
        @JavascriptInterface public void brightness(float value) { runOnUiThread(() -> {WindowManager.LayoutParams p=getWindow().getAttributes();p.screenBrightness=value < 0 ? -1 : Math.max(.02f,Math.min(1,value));getWindow().setAttributes(p);}); }
        @JavascriptInterface public void refreshScreen(boolean full) { if(full) runOnUiThread(MainActivity.this::flashRefresh); }
        @JavascriptInterface public float systemFontScale() {
            try { return getResources().getConfiguration().fontScale; } catch (Throwable e) { return 1f; }
        }
        @JavascriptInterface public String deviceName() {
            return (android.os.Build.MANUFACTURER + " " + android.os.Build.MODEL).trim();
        }
        @JavascriptInterface public void saveText(String text, String name) {
            if(text==null||name==null)return;
            if(text.length()>10*1024*1024){send("error",JSONObject.quote("摘录超过 10 MB，请使用完整书库备份"));return;}
            synchronized(MainActivity.this){if(exportFile!=null||exportText!=null||exportStream!=null){send("error",JSONObject.quote("请先完成当前保存任务"));return;}exportText=text;}
            runOnUiThread(() -> {try{Intent i=new Intent(Intent.ACTION_CREATE_DOCUMENT);i.addCategory(Intent.CATEGORY_OPENABLE);i.setType("text/markdown");i.putExtra(Intent.EXTRA_TITLE,name.replaceAll("[\\\\/:*?\"<>|]","_"));startActivityForResult(i,EXPORT);}catch(Exception e){exportText=null;send("error",JSONObject.quote("未找到可用的文件保存位置"));}});
        }
        @JavascriptInterface public void minimize() { runOnUiThread(() -> moveTaskToBack(true)); }
    }
}
