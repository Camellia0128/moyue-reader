# 参与贡献

欢迎提交 Issue 和 Pull Request。先阅读 README、docs/BUILD.md 和 docs/ARCHITECTURE.md。

使用专用测试书库并保留备份。提交前运行 `npm ci`、`npm run build:web`、`npm test`，再按变更运行浏览器回归、Android 构建与 lint。数据迁移、备份、PDF 兼容和原生桥接修改需验证真实失败场景。

说明问题触发方式、修复行为、验证结果与实际测试设备；UI 修改附实际截图。不要把模拟器结果写成全部真机兼容。

不要提交签名密钥、密码、本机 SDK 路径、用户书籍、未授权字体/词典、阅读数据、构建目录或设计参考照片。新增依赖保留许可与声明。原创贡献按 MIT License 提供。

缺陷报告优先附原创最小样例。安全问题若仓库启用 GitHub 私下漏洞报告，请使用该入口；避免在公开 Issue 附个人数据或凭据。
