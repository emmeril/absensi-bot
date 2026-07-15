const { parentPort } = require("worker_threads");
const { verifyFace } = require("../services/face-verification");

parentPort.on("message", async ({ jobId, userId, photo }) => {
  try {
    const result = await verifyFace(userId, photo);
    parentPort.postMessage({ jobId, result });
  } catch (error) {
    parentPort.postMessage({
      jobId,
      error: {
        message: error.message,
        code: error.code || "FACE_VERIFY_ERROR",
      },
    });
  }
});
