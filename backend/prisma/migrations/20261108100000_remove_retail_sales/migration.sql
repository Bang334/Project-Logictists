BEGIN;

-- Stop the old API and workers before migrating. Keep shared transport history.
LOCK TABLE "orders" IN SHARE ROW EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "orders"
    WHERE "orderType" IN ('RETAIL_PICKUP', 'RETAIL_DELIVERY')
      AND "status" IN ('CONFIRMED', 'ASSIGNED', 'IN_TRANSIT')
  ) THEN
    RAISE EXCEPTION 'Resolve open retail orders before removing the sales schema';
  END IF;
END $$;

-- Retire undelivered sales events while preserving their audit records.
UPDATE "outbox_events"
SET "deadLetteredAt" = CURRENT_TIMESTAMP,
    "lastError" = 'Retail sales module retired',
    "lockedAt" = NULL,
    "lockedBy" = NULL,
    "nextAttemptAt" = NULL
WHERE "publishedAt" IS NULL AND "deadLetteredAt" IS NULL
  AND (
    starts_with("eventType", 'RETAIL_')
    OR starts_with("eventType", 'SALES_ORDER_')
    OR starts_with("eventType", 'feedback.')
    OR "eventType" = 'ORDER_SOURCE_ALLOCATED'
  );

-- The IDs on shared rows remain as historical metadata.
ALTER TABLE "order_items" DROP CONSTRAINT "order_items_skuId_fkey";
ALTER TABLE "packages" DROP CONSTRAINT "packages_fulfillmentGroupId_fkey";

-- Dropping the group together removes its internal foreign keys. Any unexpected
-- dependency from a shared table stops the migration and rolls it back.
DROP TABLE
  "categories",
  "products",
  "skus",
  "stock_balances",
  "stock_ledger_entries",
  "inventory_reservations",
  "stock_receipts",
  "stock_receipt_lines",
  "stock_adjustments",
  "stock_adjustment_lines",
  "collection_tokens",
  "customer_addresses",
  "feedback_cases",
  "feedback_messages",
  "sales_invoices",
  "sales_invoice_lines",
  "payment_transactions",
  "service_zones",
  "service_zone_provinces",
  "store_service_zones",
  "fulfillment_groups",
  "fulfillment_lines",
  "transport_requests",
  "transport_request_packages",
  "retail_quotes";

DROP TYPE
  "FulfillmentGroupStatus",
  "TransportRequestStatus",
  "StorageCondition",
  "ProductStatus",
  "SkuStatus",
  "MediaType",
  "LedgerSourceType",
  "AdjustmentReason",
  "FeedbackType",
  "FeedbackStatus",
  "FeedbackPriority",
  "PaymentTransactionType";

COMMIT;
