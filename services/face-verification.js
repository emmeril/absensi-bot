const fs = require("fs");
const path = require("path");
const canvas = require("canvas");
const faceapi = require("face-api.js");

const { Canvas, Image, ImageData } = canvas;
faceapi.env.monkeyPatch({ Canvas, Image, ImageData });

const MODEL_PATH = process.env.FACE_MODEL_PATH || path.join(__dirname, "..", "models");
const REFERENCE_PATH = path.join(__dirname, "..", "face_rec");
const REFERENCE_CACHE_LIMIT = Math.max(
  1,
  Number(process.env.FACE_REFERENCE_CACHE_LIMIT) || 500
);
const TINY_INPUT_SIZE = Number(process.env.FACE_TINY_INPUT_SIZE) || 320;
const TINY_SCORE_THRESHOLD = Number(process.env.FACE_TINY_SCORE_THRESHOLD) || 0.45;
const referenceDescriptorCache = new Map();

let modelError = null;
let modelLoaded = false;
const modelReady = Promise.all([
  faceapi.nets.tinyFaceDetector.loadFromDisk(MODEL_PATH),
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
  const tinyOptions = new faceapi.TinyFaceDetectorOptions({
    inputSize: TINY_INPUT_SIZE,
    scoreThreshold: TINY_SCORE_THRESHOLD,
  });
  let result = await faceapi
    .detectSingleFace(input, tinyOptions)
    .withFaceLandmarks()
    .withFaceDescriptor();

  // SSD is slower but helps preserve detection quality for difficult photos.
  if (!result) {
    result = await faceapi
      .detectSingleFace(input)
      .withFaceLandmarks()
      .withFaceDescriptor();
  }

  if (!result) {
    const error = new Error(`Wajah tidak ditemukan pada ${label}`);
    error.code = "FACE_NOT_DETECTED";
    throw error;
  }

  return result.descriptor;
}

async function referenceDescriptor(referenceFile) {
  const stat = fs.statSync(referenceFile);
  const cached = referenceDescriptorCache.get(referenceFile);
  if (cached?.mtimeMs === stat.mtimeMs && cached?.size === stat.size) {
    return cached.descriptor;
  }

  const referenceCanvas = await imageToCanvas(referenceFile);
  const descriptor = await detectFaceDescriptor(referenceCanvas, "foto referensi");
  referenceDescriptorCache.delete(referenceFile);
  referenceDescriptorCache.set(referenceFile, {
    descriptor,
    mtimeMs: stat.mtimeMs,
    size: stat.size,
  });
  while (referenceDescriptorCache.size > REFERENCE_CACHE_LIMIT) {
    referenceDescriptorCache.delete(referenceDescriptorCache.keys().next().value);
  }
  return descriptor;
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

  const selfieBuffer = Buffer.from(String(photo).split(",").pop(), "base64");
  const selfieCanvas = await imageToCanvas(selfieBuffer);
  const referenceFaceDescriptor = await referenceDescriptor(referenceFile);
  const selfieDescriptor = await detectFaceDescriptor(selfieCanvas, "foto selfie");
  const distance = faceapi.euclideanDistance(
    referenceFaceDescriptor,
    selfieDescriptor
  );

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
