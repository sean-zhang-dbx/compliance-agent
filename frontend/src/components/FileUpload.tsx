import React, { useRef, useState } from "react";

interface Props {
  onUpload: (files: File[]) => void;
}

export default function FileUpload({ onUpload }: Props) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  const handleFiles = (fileList: FileList | null) => {
    if (!fileList) return;
    const files = Array.from(fileList);
    onUpload(files);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    handleFiles(e.dataTransfer.files);
  };

  return (
    <div
      style={{
        ...styles.dropZone,
        ...(dragOver ? styles.dropZoneActive : {}),
      }}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
      onClick={() => fileInputRef.current?.click()}
    >
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept=".xlsx,.xlsm,.xlsb,.csv,.pdf,.png,.jpg,.jpeg"
        style={{ display: "none" }}
        onChange={(e) => handleFiles(e.target.files)}
      />
      <span style={styles.icon}>📎</span>
      <span style={styles.text}>
        {dragOver
          ? "Drop files here"
          : "Click or drag files (xlsx, csv, pdf, images)"}
      </span>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  dropZone: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "6px 12px",
    marginBottom: 8,
    border: "1px dashed #ccc",
    borderRadius: 8,
    cursor: "pointer",
    transition: "all 0.15s",
    fontSize: 12,
    color: "#888",
  },
  dropZoneActive: {
    borderColor: "#f36f21",
    background: "rgba(243,111,33,0.05)",
    color: "#f36f21",
  },
  icon: { fontSize: 16 },
  text: { flex: 1 },
};
