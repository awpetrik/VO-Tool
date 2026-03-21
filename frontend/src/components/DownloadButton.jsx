function DownloadButton({ enhancedBlob, format, onDownload }) {
  const download = () => {
    if (!enhancedBlob) return;
    const ext = format.toLowerCase();
    const url = URL.createObjectURL(enhancedBlob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `enhanced_audio.${ext}`;
    a.click();
    URL.revokeObjectURL(url);
    onDownload?.();
  };

  return (
    <button className="btn btn-primary btn-full" onClick={download} disabled={!enhancedBlob}>
      Download Enhanced Audio
    </button>
  );
}

export default DownloadButton;
