const fs = require("fs");
const path = require("path");
const canvas = require("canvas");
const faceapi = require("face-api.js");

const { Canvas, Image, ImageData } = canvas;
faceapi.env.monkeyPatch({ Canvas, Image, ImageData });

const MODEL_PATH = process.env.FACE_MODEL_PATH || path.join(__dirname, "..", "models");
const REFERENCE_PATH = path.join(__dirname, "..", "face_rec");

let modelError = null;
let modelLoaded = false;
const modelReady = Promise.all([
  faceapi.nets.ssdMobilenetv1.loadFromDisk(MODEL_PATH),
  faceapi.nets.faceRecognitionNet.loadFromDisk(MODEL_PATH),
  faceapi.nets.faceLandmark68Net.loadFromDisk(MODEL_PATH),
])
  .then(() => {
    modelLoaded = true;
    console.log("✅ Model verifikasi wajah siap di server utama");
    return true;
  })
  .catch((error) => {
    modelError = error;
    console.error("❌ Model verifikasi wajah gagal dimuat:", error.message);
    return false;
  });

async function imageToCanvas(source) {
  const image = await canvas.loadImage(source);
  const output = canvas.createCanvas(image.width, image.height);
  output.getContext("2d").drawImage(image, 0, 0);
  return output;
}

async function detectFaceDescriptor(input, label) {
  const result = await faceapi
    .detectSingleFace(input)
    .withFaceLandmarks()
    .withFaceDescriptor();

  if (!result) {
    const error = new Error(`Wajah tidak ditemukan pada ${label}`);
    error.code = "FACE_NOT_DETECTED";
    throw error;
  }

  return result.descriptor;
}

async function verifyFace(id, photo) {
  if (!(await modelReady)) {
    const error = new Error(modelError?.message || "Model wajah belum siap");
    error.code = "MODEL_NOT_READY";
    throw error;
  }

  const safeId = String(id || "").replace(/\D/g, "");
  const referenceFile = path.join(REFERENCE_PATH, `${safeId}.jpg`);
  if (!fs.existsSync(referenceFile)) {
    const error = new Error("Foto referensi wajah tidak ditemukan");
    error.code = "REFERENCE_NOT_FOUND";
    throw error;
  }

  const referenceCanvas = await imageToCanvas(referenceFile);
  const selfieBuffer = Buffer.from(String(photo).split(",").pop(), "base64");
  const selfieCanvas = await imageToCanvas(selfieBuffer);
  const referenceDescriptor = await detectFaceDescriptor(
    referenceCanvas,
    "foto referensi"
  );
  const selfieDescriptor = await detectFaceDescriptor(selfieCanvas, "foto selfie");
  const distance = faceapi.euclideanDistance(referenceDescriptor, selfieDescriptor);

  return { match: distance < 0.45, distance };
}

function faceServiceStatus() {
  return {
    ready: modelLoaded,
    error: modelError?.message || null,
    modelPath: MODEL_PATH,
  };
}

module.exports = { verifyFace, faceServiceStatus };
