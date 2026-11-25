import { createContext, useContext } from "react";

export interface ToastItem {
  id: string;
  title: string;
  description?: string;
}

export interface ToastContextValue {
  pushToast: (toast: Omit<ToastItem, "id">) => void;
}

export const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error("useToast must be used within ToastProvider");
  }
  return ctx;
}
