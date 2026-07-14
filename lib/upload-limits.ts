export interface SizedUpload {
  size: number;
}

export interface UploadLimits {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
}

export function uploadSetError(files: readonly SizedUpload[], limits: UploadLimits): string | null {
  if (files.length === 0) return "file required";
  if (files.length > limits.maxFiles) return `too many files (max ${limits.maxFiles})`;
  if (files.some((file) => !Number.isFinite(file.size) || file.size <= 0)) return "file empty or invalid";
  if (files.some((file) => file.size > limits.maxFileBytes)) return "file too large";
  const total = files.reduce((sum, file) => sum + file.size, 0);
  if (!Number.isSafeInteger(total) || total > limits.maxTotalBytes) return "total upload too large";
  return null;
}
