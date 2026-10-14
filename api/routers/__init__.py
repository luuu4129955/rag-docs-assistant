"""HTTP 路由层。

P0 只有 health；业务路由按 P3 起的顺序逐条迁移：
    health → auth → documents/conversations（读）→（写）→ search/chat → jobs
"""
