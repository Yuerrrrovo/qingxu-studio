# 青序 · 网站托管版

这是从你 E 盘“青序-协作整合版”复制出的独立发布包。原本地程序与 `.env` 均未修改。

**搭配花生壳 Drop 时：** 本包用作 AI 与动作分析后端。在 Render 额外设置 `QINGXU_FRONTEND_ORIGIN=https://实际Drop网页域名`（不带路径和末尾斜杠），并保存部署。Drop 前端的“连接 AI 后端”填写本服务网址和网站访问口令即可。跨站请求使用临时访问凭证，不依赖第三方 Cookie。真实 API Key 仍只在后台。

**目前是已整理、待在 Render 构建验证的部署包，还不是已经上线的网站。** 你的电脑无需安装 Docker；Render 会根据 Dockerfile 构建。此电脑没有 Docker，尚未验证 Linux 镜像构建和实际公网相机效果。

## 你现在先做什么

1. 注册或登录 GitHub：https://github.com/ 。创建一个 **Private（私有）** 仓库，名称可用 `qingxu-studio`。
2. 解压本部署包。打开仓库的 **Add file → Upload files**，把解压文件夹**里面的全部文件和子文件夹**拖进去，提交保存。仓库首页应直接看见 `Dockerfile`、`render.yaml`、`app`、`hosting`，不要再包一层总文件夹，也不要上传 ZIP 本身。
3. 登录 Render：https://dashboard.render.com/ ，可以使用 GitHub 账号关联登录。授权时仅选择刚创建的仓库。
4. 点击 **New → Web Service**，连接该仓库。**Language 选 Docker**，Dockerfile Path 为 `./Dockerfile`，Docker Command 留空，Health Check Path 填 `/healthz`。选择你需要的计算规格；可以先选 Free 验证，动作检测不保证在 Free 上稳定运行。
5. 在 Environment 中选择 **Add from .env**。若已有单独的“私用部署配置”，导入其中 `Render-后台导入.env` 的内容，便会一次填好 DeepSeek 密钥、接口地址、模型和网站访问口令；不需要重新输入每一项。没有私用配置时，按下表填写。**私用配置留在自己电脑，只有发布包里的文件上传 GitHub。**
6. 核对平台展示的服务和费用后开始部署。构建完成且服务显示 Live 后，打开平台分配的 `https://…onrender.com` 网址，输入访问口令。访问口令可在后台 Environment 的 `QINGXU_ACCESS_PASSWORD` 查看；它与 API Key 不同。

也可以使用 **New → Blueprint**，连接同一仓库，让平台读取 `render.yaml`。该方式会提示填写 `AI_API_KEY`，并自动生成网站访问口令；配置使用 Free，不主动选择付费实例。

## 后台填写的位置

进入 Render 的该服务 → **Environment**。密钥只填在平台后台，前端不接收或展示密钥。

| 名称 | 填什么 |
| --- | --- |
| `AI_PROVIDER` | `DeepSeek` |
| `AI_BASE_URL` | `https://api.deepseek.com` |
| `AI_MODEL` | `deepseek-flash` |
| `AI_API_KEY` | 你自己的 DeepSeek 密钥 |
| `AI_JSON_MODE` | `true` |
| `QINGXU_ACCESS_PASSWORD` | Blueprint 自动生成；手动部署则自己设至少 12 个字符 |
| `QINGXU_ENABLE_VISION` | `true`，同时启动 Python 动作分析 |
| `QINGXU_FRONTEND_ORIGIN` | 搭配 Drop 时填实际前端 HTTPS 域名；独立使用本包时可留空 |

Render 会自动提供 `PORT` 和 `RENDER_EXTERNAL_URL`，不用填写。更换其他容器托管平台时，还需要设置 `PUBLIC_ORIGIN=https://你的网站域名`。

密钥修改后选 **Save and deploy** 才会作用于新进程。不要把你 E 盘带真实密钥的 `.env`、会员导出数据或完整个人视频上传到 GitHub。此部署包没有复制密钥。

## 发布后保留什么

- 原有 3D 场馆、Liquid Glass、导航气泡、普拉提教程、会员档案、训练与今日复盘、饮食和 AI 调用。
- 浏览器相机预览，以及同意后将标定帧、人体检测帧和动作取样发送至托管服务器。
- 补传视频仍先在浏览器中选段、提取画面，最多分析 60 秒；不上传整个原视频，不保存帧文件。
- Python 动作服务仅监听容器内的回环地址，由同源后台转发。外接网络摄像头的“服务器读取设备推流”接口不对公网开放；USB 摄像头由浏览器调用，保持原流程。

原运行文件在 `app/`，校验值在 `original-files.sha256.json`。新增的 `hosting/` 负责口令、限流、同源转发与云端提示，原导航、场景和玻璃效果源码未重写。

## 必须了解的实际限制

- **尚无真正的云端会员账号和数据库同步。** 演示站口令仅控制进入网站，不能代替多用户账号系统。会员记录仍在各自浏览器的本机存储中；电脑原来 `127.0.0.1` 下的记录不会自动出现在新网址，其他设备也不会自动同步。
- **这次会把动作取样画面发送到服务器。** 相机默认关闭，逐次授权后才发送。本站视觉代码不主动保存取样帧或原视频，聊天模型继续按会员的共享选择接收资料和结构化观察。托管平台与 AI 平台仍有其自身的数据规则。
- 免费 Web Service 闲置 15 分钟会休眠，再次访问可能等待约一分钟。内存、CPU 与网络延迟可能让动作检测无法稳定达到所需取样速度，代码会停止并提示，不生成虚假成功。**没有保证 Free 能稳定运行动作模型。** 如发生内存不足，先看日志；可暂设 `QINGXU_ENABLE_VISION=false` 验证网页与聊天，动作分析会明确显示未配置，或由你决定是否升级计算规格。
- 不使用临时磁盘来存 API Key 或会员资料。平台环境变量保存 Key；会员资料仍在浏览器。服务重启会要求重新输入访问口令，但不清空浏览器会员记录。
- 当前视觉服务最多两个分析会话，适合少量受邀演示，尚未做多人并发生产扩容。
- 实际 DeepSeek 可用性、余额和模型返回效果，发布后还需用不含隐私的普通提问确认。没有把本次本地测试当成真实 AI 或真人动作验收。

## 发布后的检查

1. 未输入访问口令时只看到进入页；直接打开 `/api/agent/status` 应不能访问。
2. 输入访问口令后，能看见场馆、切换面板和播放教程。
3. AI 面板显示已配置 DeepSeek，发送一句普通问候确认接口；密钥本身不应出现在网页源码或请求正文中。
4. 使用 Chrome / Edge 或手机系统浏览器的 HTTPS 网址，手动允许相机；勾选取样授权后再分析。不允许相机仍能计时和复盘。
5. 用合成会员检查资料、身体状态、饮食和训练复盘在同一浏览器刷新后保留，再验证视频选段。真实动作准确性仍需单独评估。

## 官方参考

- Docker 部署：https://render.com/docs/docker
- 服务端口、HTTPS 与自动域名：https://render.com/docs/web-services
- 环境变量与密钥：https://render.com/docs/configure-environment-variables
- Blueprint 配置：https://render.com/docs/blueprint-spec
- 免费实例限制：https://render.com/docs/free
- DeepSeek 参数：https://api-docs.deepseek.com/

涉及康复与慢病内容必须遵循专业意见，医疗诊断与治疗决策由具备相应资质的专业人员做出。
