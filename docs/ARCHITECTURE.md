# 架构与数据

Java Android 宿主承载本地 WebView 阅读界面，原生 JavaScript / CSS 经 esbuild 输出到生成目录 `app/src/main/assets/web/`，随 APK 离线分发。

| 路径 | 职责 |
| --- | --- |
| app/src/main/java/cn/moyue/reader/MainActivity.java | WebView、原生桥接、SAF 导入导出、亮度、字体与生命周期 |
| app/src/main/java/cn/moyue/reader/NativePdfStore.java | Android PdfRenderer 兼容渲染及系统版本支持的文字能力 |
| web/app.js | 书库、阅读状态、交互、任务失效与保存协调 |
| web/formats.js、pdf.js、native-pdf.js | 格式解析和两条 PDF 渲染路径 |
| web/storage.js、backup.js | IndexedDB、独立进度、校验备份与原子恢复 |
| web/dict-worker.js、dict-service.js | 后台词典解析、按需读取释义 |
| web/library-search.js、vocabulary.js、pdf-notes.js | 持久索引、生词复习、PDF 批注 |
| scripts/ | 打包、原创示例生成、本地 QA 静态服务器 |

主数据库 `moyue-reader` 为 IndexedDB v4，分开保存 books、documents、originals、progress、dicts、vocab、searchUnits、searchMeta。主题和部分偏好使用 localStorage，导入字体由 Android 私有文件管理。不要随意改变 WebView 本地 origin，否则原同源数据将不可访问。

Manifest 不申请网络权限。导入 HTML / EPUB 经净化后阅读；原生桥接只服务本地应用资源，不应暴露给外部网页。

备份恢复先校验格式、容量、SHA-256 与数据结构，重新解析书籍再提交。保存失败不得把内存状态当作已持久化。升级解析器与定位逻辑需保留旧进度、批注和上下文锚点恢复能力。

PDF 文字层失败与页面渲染失败分开处理；原生兼容引擎是必要的阅读后备路径。全屏刷新图层不等于硬件波形驱动。
