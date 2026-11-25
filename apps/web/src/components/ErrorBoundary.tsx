import React from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";

interface ErrorBoundaryState {
  hasError: boolean;
  message: string;
}

export class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  ErrorBoundaryState
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, message: "" };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, message: error.message || "Unexpected rendering error" };
  }

  override render() {
    if (this.state.hasError) {
      return (
        <div className="flex min-h-screen items-center justify-center bg-background p-6">
          <div className="max-w-md rounded-lg border bg-card p-6 text-center shadow-sm">
            <AlertTriangle className="mx-auto mb-3 h-10 w-10 text-destructive" />
            <h1 className="text-lg font-semibold">Application Error</h1>
            <p className="mt-2 text-sm text-muted-foreground">{this.state.message}</p>
            <Button
              className="mt-4"
              onClick={() => this.setState({ hasError: false, message: "" })}
            >
              Recover View
            </Button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
