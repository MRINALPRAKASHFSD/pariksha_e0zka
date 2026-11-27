import type { ApiErrorResponse, ApiSuccessResponse } from "@pariksha/shared";

export class ApiClientError extends Error {
  public readonly status: number;
  public readonly code: string;
  public readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "ApiClientError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

let inMemoryCsrfToken: string | null = null;
let sessionExpiredHandler: ((reason: string) => void) | null = null;

export function setInMemoryCsrfToken(token: string | null): void {
  inMemoryCsrfToken = token;
}

export function getInMemoryCsrfToken(): string | null {
  return inMemoryCsrfToken;
}

export function registerSessionExpiredHandler(handler: ((reason: string) => void) | null): void {
  sessionExpiredHandler = handler;
}

export async function ensureCsrfToken(): Promise<string> {
  if (inMemoryCsrfToken) {
    return inMemoryCsrfToken;
  }
  const response = await fetch("/api/v1/auth/csrf", {
    method: "GET",
    credentials: "include",
  });
  const payload = (await response.json()) as ApiSuccessResponse<{ csrfToken: string }> | ApiErrorResponse;
  if (!response.ok || !payload.success) {
    throw new ApiClientError(
      response.status,
      payload.success ? "CSRF_FETCH_FAILED" : payload.error.code,
      payload.success ? "Failed to acquire CSRF token" : payload.error.message,
    );
  }
  inMemoryCsrfToken = payload.data.csrfToken;
  return payload.data.csrfToken;
}

export async function apiRequest<T>(
  path: string,
  options: RequestInit & { skipAuthRedirect?: boolean } = {},
): Promise<T> {
  const { skipAuthRedirect = false, headers: customHeaders, ...rest } = options;
  const method = (rest.method ?? "GET").toUpperCase();
  const isMutation = ["POST", "PUT", "PATCH", "DELETE"].includes(method);
  const isFormData = typeof FormData !== "undefined" && rest.body instanceof FormData;

  const headers = new Headers(customHeaders);
  if (rest.body && !isFormData && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  if (isMutation) {
    const csrf = await ensureCsrfToken();
    headers.set("X-CSRF-Token", csrf);
  }

  const response = await fetch(`/api/v1${path}`, {
    ...rest,
    method,
    headers,
    credentials: "include",
  });

  const contentType = response.headers.get("content-type") ?? "";
  const isJson = contentType.includes("application/json");
  const payload = isJson
    ? ((await response.json()) as ApiSuccessResponse<T> | ApiErrorResponse)
    : null;

  if (!response.ok || !payload || !payload.success) {
    const errCode = payload && !payload.success ? payload.error.code : `HTTP_${response.status}`;
    const errMessage =
      payload && !payload.success ? payload.error.message : `Request failed with status ${response.status}`;
    const errDetails = payload && !payload.success ? payload.error.details : undefined;

    if (
      !skipAuthRedirect &&
      (response.status === 401 || errCode === "ACCOUNT_INACTIVE" || errCode === "SESSION_INVALID")
    ) {
      inMemoryCsrfToken = null;
      sessionExpiredHandler?.(errMessage);
    }

    throw new ApiClientError(response.status, errCode, errMessage, errDetails);
  }

  return payload.data;
}

export async function apiUploadWithProgress<T>(
  path: string,
  formData: FormData,
  onProgress?: (percent: number) => void,
): Promise<T> {
  const csrf = await ensureCsrfToken();

  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/v1${path}`, true);
    xhr.withCredentials = true;
    xhr.setRequestHeader("X-CSRF-Token", csrf);

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && onProgress) {
        onProgress(Math.min(100, Math.round((event.loaded / event.total) * 100)));
      }
    };

    xhr.onload = () => {
      try {
        const parsed = JSON.parse(xhr.responseText) as ApiSuccessResponse<T> | ApiErrorResponse;
        if (xhr.status >= 200 && xhr.status < 300 && parsed.success) {
          onProgress?.(100);
          resolve(parsed.data);
          return;
        }
        const errCode = !parsed.success ? parsed.error.code : `HTTP_${xhr.status}`;
        const errMsg = !parsed.success ? parsed.error.message : `Upload failed (${xhr.status})`;
        const errDetails = !parsed.success ? parsed.error.details : undefined;

        if (xhr.status === 401 || errCode === "ACCOUNT_INACTIVE" || errCode === "SESSION_INVALID") {
          inMemoryCsrfToken = null;
          sessionExpiredHandler?.(errMsg);
        }
        reject(new ApiClientError(xhr.status, errCode, errMsg, errDetails));
      } catch {
        reject(new ApiClientError(xhr.status, "UPLOAD_PARSE_ERROR", "Unexpected server response"));
      }
    };

    xhr.onerror = () => {
      reject(new ApiClientError(0, "NETWORK_ERROR", "Network error during file upload"));
    };

    xhr.send(formData);
  });
}
