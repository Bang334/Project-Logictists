-- READ ONLY. Run only against an explicitly selected, authorized environment.
-- Missing tables/columns are a schema reconciliation blocker, not permission to db push.
BEGIN READ ONLY;
SELECT table_name, column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name IN
  ('orders', 'order_items', 'order_stops', 'packages', 'allocations', 'processed_commands')
ORDER BY table_name, ordinal_position;

SELECT conrelid::regclass AS relation, conname, convalidated, pg_get_constraintdef(oid)
FROM pg_constraint WHERE conrelid IN
  ('orders'::regclass, 'order_items'::regclass, 'order_stops'::regclass,
   'packages'::regclass, 'allocations'::regclass);

-- Do not create guessed packages from these old aggregate values.
SELECT i.id AS item_id, i."orderId", i.quantity, i."weightKg",
       i."lengthCm", i."widthCm", i."heightCm", count(p.id) AS physical_packages
FROM order_items i LEFT JOIN packages p ON p."orderItemId" = i.id
GROUP BY i.id HAVING count(p.id) <> i.quantity OR count(p.id) = 0;

SELECT id, "orderItemId", "lengthMm", "widthMm", "heightMm", "weightG"
FROM packages WHERE "lengthMm" <= 0 OR "widthMm" <= 0 OR "heightMm" <= 0 OR "weightG" <= 0;

SELECT a.id, a."orderItemId", a."packageId", a."allocatedQuantity"
FROM allocations a JOIN packages p ON p.id = a."packageId"
WHERE p."orderItemId" <> a."orderItemId" OR a."allocatedQuantity" <> 1;

SELECT "packageId", count(*) FROM allocations
WHERE "packageId" IS NOT NULL AND status IN ('ACTIVE', 'ALLOCATED')
GROUP BY "packageId" HAVING count(*) > 1;

SELECT o.id AS order_id,
  count(s.id) FILTER (WHERE s.type = 'PICKUP') AS pickups,
  count(s.id) FILTER (WHERE s.type = 'DELIVERY') AS deliveries
FROM orders o LEFT JOIN order_stops s ON s."orderId" = o.id
GROUP BY o.id HAVING count(s.id) FILTER (WHERE s.type = 'PICKUP') <> 1
  OR count(s.id) FILTER (WHERE s.type = 'DELIVERY') <> 1;
COMMIT;
