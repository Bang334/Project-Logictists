-- Reconcile only the drifted, empty POD table before the pending M3.5 ledger step.
-- This script does not modify _prisma_migrations.
BEGIN;

LOCK TABLE public.pod_files IN ACCESS EXCLUSIVE MODE;

DO $$
DECLARE
  evidence_oid oid;
BEGIN
  IF EXISTS (SELECT 1 FROM public.pod_files) THEN
    RAISE EXCEPTION 'POD reconciliation requires an empty table; inventory legacy rows first';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute a
    LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE a.attrelid = 'public.pod_files'::regclass AND a.attname = 'sizeBytes'
      AND NOT a.attisdropped AND a.atttypid = 'integer'::regtype
      AND a.attgenerated = '' AND a.attidentity = ''
      AND (d.oid IS NULL OR pg_get_expr(d.adbin, d.adrelid) = '0')
  ) THEN
    RAISE EXCEPTION 'Expected an existing integer sizeBytes column with no default or the M3.5 temporary default';
  END IF;

  evidence_oid := to_regtype('public."PodEvidenceType"');
  IF evidence_oid IS NULL THEN
    CREATE TYPE public."PodEvidenceType" AS ENUM ('PHOTO', 'SIGNATURE');
    evidence_oid := 'public."PodEvidenceType"'::regtype;
  END IF;

  IF (
    SELECT array_agg(e.enumlabel::text ORDER BY e.enumsortorder)
    FROM pg_enum e WHERE e.enumtypid = evidence_oid
  ) IS DISTINCT FROM ARRAY['PHOTO', 'SIGNATURE'] THEN
    RAISE EXCEPTION 'Unexpected public.PodEvidenceType labels or type';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = 'public.pod_files'::regclass AND attname = 'evidenceType' AND NOT attisdropped
  ) THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_attribute a
      LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE a.attrelid = 'public.pod_files'::regclass AND a.attname = 'evidenceType'
        AND NOT a.attisdropped AND a.atttypid = evidence_oid
        AND a.attgenerated = '' AND a.attidentity = ''
        AND (d.oid IS NULL OR pg_get_expr(d.adbin, d.adrelid) = '''PHOTO''::"PodEvidenceType"')
    ) THEN
      RAISE EXCEPTION 'Unexpected existing evidenceType column';
    END IF;
  ELSE
    ALTER TABLE public.pod_files ADD COLUMN "evidenceType" public."PodEvidenceType";
  END IF;
END $$;

ALTER TABLE public.pod_files
  ALTER COLUMN "sizeBytes" SET NOT NULL,
  ALTER COLUMN "sizeBytes" DROP DEFAULT,
  ALTER COLUMN "evidenceType" SET NOT NULL,
  ALTER COLUMN "evidenceType" DROP DEFAULT;

COMMIT;
