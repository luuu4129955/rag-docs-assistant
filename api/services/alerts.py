"""告警出口：死信、上游持续报错这类「需要有人知道」的事件走这里。

配了 NUXT_ALERT_WEBHOOK 就把事件 POST 过去（飞书 / 钉钉 / Slack 的机器人
都接受 JSON，字段名各家略有不同，这里用 content + text 双写兼容）；
没配就只打结构化日志，不至于因为没配 webhook 就把事件丢掉。
"""


from ..config import Settings
from ..http import make_client
from ..log import log_event


async def alert(settings: Settings, title: str, **data: object) -> None:
    # 无论有没有 webhook，都先落一条结构化日志（平台日志里能直接搜 alert）
    log_event("alert", title=title, **data)

    webhook = (settings.alert_webhook or "").strip()
    if not webhook:
        return

    text = f"【Docs QA 告警】{title}\n{data}"
    try:
        async with make_client(5.0) as client:
            await client.post(
                webhook,
                json={"msg_type": "text", "content": {"text": text}, "text": text},
            )
    except Exception as exc:  # noqa: BLE001 —— 告警失败不能变成新的故障源
        log_event("alert.webhook_failed", message=str(exc)[:200])
