# BJL Monitor

百家乐桌台监控和视频流检查工具，包含两部分：

- `web_monitor/`：Node.js Web 监控台，直连游戏 WebSocket，记录桌台、局数、开奖结果、同牌统计，并可播放桌台视频流。
- `wss_video_stream_gui/`：Python Tkinter GUI，用于检查单路 WSS H264 视频流，异常时保存可播放片段和元数据。

## 环境

- Windows + PowerShell
- Node.js 20+
- Python 3.10+
- `uv`，用于管理 Python 虚拟环境

## 安装

```powershell
cd E:\python\wss_video_stream_gui
uv venv
uv pip install -r requirements.txt
```

如果不用 `uv`，也可以用标准虚拟环境：

```powershell
python -m venv .venv
.\.venv\Scripts\pip install -r requirements.txt
```

## 启动 Web 监控

```powershell
.\start_web_monitor.ps1
```

打开：

```text
http://127.0.0.1:9333
```

默认监控地址：

```text
ws://6.zd10086.com/gate1/socket.io/?EIO=3&transport=websocket
```

运行时数据写入 `web_monitor/data/`，包含：

- `tables.jsonl`：桌台信息和桌台路单局号。
- `rounds.jsonl`：开奖结果、局数、牌面、来源。
- `events.jsonl`：连接、重连、解码错误等事件。

这些文件是运行数据，不提交到 Git。

## Web 监控功能

- 自动重连游戏 WebSocket。
- 记录所有 `TableInfoReplay` 桌台信息。
- 记录 `GameInfoReplay` 开奖局号、点数、庄闲牌面和推导结果。
- 普通百家乐可从 `TableInfoReplay.field8` 补充路单结果。
- 每个桌台显示局数，重新开局后按桌台路单从 1 开始记录。
- 开奖列表支持分页和每页数量选择。
- 同牌统计独立 Tab，只统计“极速百家乐”和“百家乐”，按庄闲花色点数完全一致分组。
- 只针对“极速百家乐”保存每局开牌视频，按桌台和小时分目录，保存 24 小时后自动删除。
- 桌台详情可播放关联 WSS 视频流。

极速百家乐单局视频保存位置：

```text
web_monitor/data/round_videos/<桌台名>/<YYYYMMDD_HH>/<桌台名> 第<局数>局 <YYYYMMDD_HHMMSS> <局号>.mp4
```

示例：

```text
web_monitor/data/round_videos/Q极速百28号/20260718_13/Q极速百28号 第54局 20260718_130246 260718w2907190059054.mp4
```

视频目录属于运行数据，不提交 Git。服务会优先使用 `.venv` 里 `imageio-ffmpeg` 自带的 ffmpeg；如果没有安装 Python 依赖，则退回系统 PATH 里的 `ffmpeg`。

## 启动 GUI

```powershell
.\run_gui.ps1
```

GUI 默认检查 `wss://wt1.shipin1hao.com:8091/9004`。视频流异常片段保存到 `recordings/`，每次异常生成：

- `.mp4`：异常前后窗口内的可播放视频。
- `.jsonl`：接收时间、帧信息、H264 NAL、关键帧、SEI 摄像头元数据。

`recordings/` 是本地采集数据，不提交到 Git。

## 测试

```powershell
Get-ChildItem -File .\tests\*.test.js | ForEach-Object {
    node $_.FullName
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

python -m unittest discover -s tests -p 'test_*.py'

node --check .\web_monitor\monitor.js
node --check .\web_monitor\store.js
node --check .\web_monitor\server.js
node --check .\web_monitor\public\app.js
```

## 目录说明

```text
web_monitor/              Web 监控服务、数据存储、前端页面
web_monitor/public/       浏览器界面
wss_video_stream_gui/     Python GUI 和视频流解析模块
tests/                    Node.js 和 Python 测试
run_gui.ps1               GUI 启动入口
start_web_monitor.ps1     Web 监控启动入口
```
