import React, { useRef, useState } from "react";
import { FileUp, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn, formatFileSize } from "@/lib/utils";

interface FileDropzoneProps {
  files: File[];
  onFilesChange: (files: File[]) => void;
  maxFiles?: number;
  uploadProgress?: number | null;
  disabled?: boolean;
  inputId?: string;
  label?: string;
}

export function FileDropzone({
  files,
  onFilesChange,
  maxFiles = 5,
  uploadProgress = null,
  disabled = false,
  inputId = "academic-file-input",
  label = "Attach academic files",
}: FileDropzoneProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [dragging, setDragging] = useState(false);

  const addFiles = (incoming: FileList | null) => {
    if (!incoming || disabled) return;
    const merged = [...files, ...Array.from(incoming)].slice(0, maxFiles);
    onFilesChange(merged);
  };

  const handleDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    addFiles(event.dataTransfer.files);
  };

  return (
    <div className="space-y-2">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          if (!disabled) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
        className={cn(
          "flex flex-col items-center justify-center rounded-lg border-2 border-dashed p-5 text-center transition-colors",
          dragging ? "border-primary bg-primary/5" : "border-border bg-muted/20",
          disabled && "opacity-60",
        )}
      >
        <FileUp className="mb-2 h-6 w-6 text-muted-foreground" />
        <p className="text-sm font-medium">{label}</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Drag &amp; drop or browse (PDF, DOCX, PPTX, XLSX, TXT, PNG, JPG, WebP — max {maxFiles}{" "}
          files, 10 MB each)
        </p>
        <input
          id={inputId}
          ref={inputRef}
          type="file"
          multiple
          accept=".pdf,.docx,.pptx,.xlsx,.txt,.png,.jpg,.jpeg,.webp"
          className="sr-only"
          disabled={disabled}
          onChange={(e) => {
            addFiles(e.target.files);
            e.target.value = "";
          }}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="mt-3"
          disabled={disabled || files.length >= maxFiles}
          onClick={() => inputRef.current?.click()}
        >
          Browse Files
        </Button>
      </div>

      {files.length > 0 && (
        <ul className="space-y-1.5">
          {files.map((file, idx) => (
            <li
              key={`${file.name}-${idx}`}
              className="flex items-center justify-between rounded-md border bg-card px-3 py-2 text-xs"
            >
              <div className="min-w-0">
                <p className="truncate font-medium">{file.name}</p>
                <p className="text-muted-foreground">{formatFileSize(file.size)}</p>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={`Remove ${file.name}`}
                disabled={disabled}
                onClick={() => onFilesChange(files.filter((_, i) => i !== idx))}
              >
                <Trash2 className="h-3.5 w-3.5 text-destructive" />
              </Button>
            </li>
          ))}
        </ul>
      )}

      {uploadProgress !== null && (
        <div className="space-y-1">
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>Uploading files...</span>
            <span>{uploadProgress}%</span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full bg-primary transition-all duration-150"
              style={{ width: `${uploadProgress}%` }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
