-- Global administrative lookup orders a bounded time range by timestamp and ID.
-- No historical data or permissions are changed. Schedule index creation for a
-- maintenance window on a large production table (regular CREATE INDEX locks writes).
CREATE INDEX "audit_logs_time_id_idx" ON "audit_logs" ("timestamp", "id");
CREATE INDEX "order_events_time_id_idx" ON "order_status_events" ("occurredAt", "id");
