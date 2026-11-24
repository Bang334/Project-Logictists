const FAILED_REASONS_REQUIRING_PHOTO = new Set([
  "ADDRESS_ISSUE",
  "ACCESS_RESTRICTED",
  "PACKAGE_DAMAGED",
]);

export function isDriverPodPhotoRequired(
  result: string,
  failureReason: string | null,
): boolean {
  return (
    result === "SUCCESS" ||
    result === "PARTIAL" ||
    (result === "FAILED" &&
      Boolean(
        failureReason && FAILED_REASONS_REQUIRING_PHOTO.has(failureReason),
      ))
  );
}
