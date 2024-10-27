import { showToast, Toast, open, getSelectedFinderItems, Clipboard } from "@raycast/api";
import fs from "fs";
import path from "path";
import axios from "axios";
import WebSocket from "ws";
import archiver from "archiver";
import stream from "stream";

const CHUNK_SIZE = 8 * 1024 * 1024; // 8MB

export default async function Command() {
  try {
    try {
      fs.accessSync("/Users", fs.constants.R_OK);
    } catch (error) {
      await showToast({
        title: "Full Disk Access Required",
        message: "Please grant Full Disk Access to Raycast in System Settings → Privacy & Security",
        style: Toast.Style.Failure,
        primaryAction: {
          title: "Open System Settings",
          onAction: () => open("x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"),
        },
      });
      return;
    }

    const selectedItems = await getSelectedFinderItems();
    if (selectedItems.length === 0) {
      await showToast({ title: "No file selected", style: Toast.Style.Failure });
      return;
    }

    const paths = selectedItems.map((item) => item.path);
    await uploadItems(paths);
  } catch (error) {
    await showToast({ title: "Error selecting file", style: Toast.Style.Failure });
  }
}

async function uploadItems(filePaths: string[]) {
  const isMultiple = filePaths.length > 1;
  const isSingleDirectory = filePaths.length === 1 && fs.statSync(filePaths[0]).isDirectory();
  const isSingleFile = filePaths.length === 1 && fs.statSync(filePaths[0]).isFile();

  let uploadName = "";
  let streamToUpload: stream.Readable;

  if (isMultiple) {
    uploadName = `archive_${Date.now()}.zip`;
    const archive = archiver("zip", { zlib: { level: 9 } });
    archive.on("error", (err) => {
      throw err;
    });
    streamToUpload = archive;

    for (const filePath of filePaths) {
      const name = path.basename(filePath);
      const stat = fs.statSync(filePath);
      if (stat.isDirectory()) {
        archive.directory(filePath, name);
      } else if (stat.isFile()) {
        archive.file(filePath, { name });
      }
    }

    archive.finalize();
  } else if (isSingleDirectory) {
    const dirPath = filePaths[0];
    uploadName = `${path.basename(dirPath)}.zip`;
    const archive = archiver("zip", { zlib: { level: 9 } });
    archive.on("error", (err) => {
      throw err;
    });
    streamToUpload = archive;
    archive.directory(dirPath, false);
    archive.finalize();
  } else if (isSingleFile) {
    const filePath = filePaths[0];
    uploadName = path.basename(filePath);
    streamToUpload = fs.createReadStream(filePath, { highWaterMark: CHUNK_SIZE });
  } else {
    await showToast({
      title: "Unsupported selection",
      message: "Selected items could not be processed.",
      style: Toast.Style.Failure,
    });
    return;
  }

  try {
    const createResponse = await axios.post("https://streamshare.wireway.ch/api/create", { name: uploadName });
    const { fileIdentifier, deletionToken } = createResponse.data;

    const toast = await showToast({
      style: Toast.Style.Animated,
      title: `Uploading ${uploadName}`,
      message: isMultiple || isSingleDirectory ? "0 MB" : "0%",
    });

    const ws = new WebSocket(`wss://streamshare.wireway.ch/api/upload/${fileIdentifier}`);

    let ackResolve: (() => void) | null = null;

    const ackPromise = () =>
      new Promise<void>((resolve) => {
        ackResolve = resolve;
      });

    const handleMessage = (ack: WebSocket.Data) => {
      if (ack.toString() === "ACK" && ackResolve) {
        ackResolve();
        ackResolve = null;
      }
    };

    ws.on("message", handleMessage);

    await new Promise<void>((resolve, reject) => {
      ws.on("open", async () => {
        let uploadedSize = 0;
        let fileSize = 0;

        try {
          if (isMultiple || isSingleDirectory) {
            for await (const chunk of streamToUpload) {
              ws.send(chunk);
              await ackPromise().catch((err) => {
                reject(err);
                ws.close();
              });
              uploadedSize += chunk.length;
              toast.message = `${(uploadedSize / (1024 * 1024)).toFixed(2)} MB`;
            }
          } else {
            const stat = fs.statSync(filePaths[0]);
            fileSize = stat.size;

            for await (const chunk of streamToUpload) {
              ws.send(chunk);
              await ackPromise().catch((err) => {
                reject(err);
                ws.close();
              });
              uploadedSize += chunk.length;
              const percentCompleted = Math.round((uploadedSize * 100) / fileSize);
              toast.message = `${percentCompleted}%`;
            }
          }

          ws.close(1000, "FILE_UPLOAD_DONE");
          resolve();
        } catch (error) {
          reject(error);
          ws.close();
        }
      });

      ws.on("error", (error) => {
        reject(error);
      });
    });

    ws.off("message", handleMessage);

    const downloadUrl = `https://streamshare.wireway.ch/download/${fileIdentifier}`;
    const deletionUrl = `https://streamshare.wireway.ch/api/delete/${fileIdentifier}/${deletionToken}`;

    await Clipboard.copy(downloadUrl);

    await showToast({
      style: Toast.Style.Success,
      title: "Copied URL to clipboard",
      message: `${uploadName}`,
      primaryAction: {
        title: "Open Download in Browser",
        onAction: () => open(downloadUrl),
      },
      secondaryAction: {
        title: "Delete File",
        onAction: async () => {
          try {
            await axios.get(deletionUrl);
            await showToast({
              style: Toast.Style.Success,
              title: "File deleted successfully",
            });
          } catch (error) {
            await showToast({
              style: Toast.Style.Failure,
              title: "Failed to delete file",
              message: error instanceof Error ? error.message : String(error),
            });
          }
        },
      },
    });
  } catch (error) {
    await showToast({
      title: `Failed to upload ${uploadName}`,
      message: error instanceof Error ? error.message : String(error),
      style: Toast.Style.Failure,
    });
  }
}
