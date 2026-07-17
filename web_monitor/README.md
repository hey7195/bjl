# Web Monitor

启动：

```powershell
cd E:\python\wss_video_stream_gui
.\start_web_monitor.ps1
```

打开：

```text
http://127.0.0.1:9333
```

后台直连：

```text
ws://6.zd10086.com/gate1/socket.io/?EIO=3&transport=websocket
```

记录文件：

```text
E:\python\wss_video_stream_gui\web_monitor\data\tables.jsonl
E:\python\wss_video_stream_gui\web_monitor\data\rounds.jsonl
E:\python\wss_video_stream_gui\web_monitor\data\events.jsonl
```

功能：

- 24 小时自动重连监控。
- 记录所有 `TableInfoReplay` 桌台信息。
- 记录所有 `GameInfoReplay` 开奖局号、点数、牌面、结果推导。
- 每个桌台可查看并播放视频流，查看开奖列表和单局原始字段。
