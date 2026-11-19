# CodeSip 工作约定

- 本目录是 CodeSip 独立仓库，远端为 fei-yu-001/CodeSip。用户已明确要求在此开发，可在验证后提交和推送本仓库。
- 用户明确要求不用子代理，所有工作由当前代理完成。
- 本项目与 Eternal Jade Scroll 游戏独立。服务名 codesip，服务目录 /opt/harmonyos/services/codesip，数据目录 /var/lib/codesip，配置目录 /etc/codesip，监听端口 4318。
- 不修改游戏目录、服务、数据库、凭据、备份或发布包。共享 nginx 的操作只新增 CodeSip 站点，通过 nginx -t 后才 reload，并前后验证游戏健康状态。
- 服务器连接资料沿用工作区 server-private 入口，不复制 SSH 私钥、环境文件、账号或用户笔记到仓库。
- .local 只用于本地凭据与验证产物，禁止提交。首次设置凭据不在日志和公开文档中输出。
- 代码只供阅读，不执行导入的源码；笔记默认只读。
- 提交前运行 npm run check、npm test、npm run build 和相关浏览器测试，并检查暂存区没有凭据或用户数据。
- 界面文案保持简洁，删除重复的宣传语与服务说明，保留操作引导、错误反馈和必要状态。
- 本项目生图使用用户提供的 image-studio 技能及预置渠道，不使用内置生图工具。
