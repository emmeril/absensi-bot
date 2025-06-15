const express = require('express');
const fs = require('fs');
const path = require('path');
const canvas = require('canvas');
const faceapi = require('face-api.js');
const cors = require('cors');
const { Canvas, Image, ImageData } = canvas;

const app = express();
app.use(cors()); 
app.use(express.json({ limit: '10mb' }));

// Setup face-api with node canvas
faceapi.env.monkeyPatch({ Canvas, Image, ImageData });

const MODEL_PATH = path.join(__dirname, 'models');
const DB_PATH = path.join(__dirname, 'face_db');

// Load model once on startup
Promise.all([
  faceapi.nets.ssdMobilenetv1.loadFromDisk(MODEL_PATH),
  faceapi.nets.faceRecognitionNet.loadFromDisk(MODEL_PATH),
  faceapi.nets.faceLandmark68Net.loadFromDisk(MODEL_PATH)
]).then(() => {
  console.log('✅ Model face-api loaded');
});

// Function to decode base64 to canvas image
async function decodeBase64Image(base64) {
  const buffer = Buffer.from(base64.split(',').pop(), 'base64');
  const img = await canvas.loadImage(buffer);
  const c = canvas.createCanvas(img.width, img.height);
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0);
  return c;
}

// POST /verify-face
app.post('/verify-face', async (req, res) => {
  const { id, photo } = req.body;
  if (!id || !photo) return res.status(400).json({ status: 'error', message: 'id dan photo wajib' });

  const referensiPath = path.join(DB_PATH, `${id}.jpg`);
  if (!fs.existsSync(referensiPath)) return res.status(404).json({ status: 'error', message: 'Referensi wajah tidak ditemukan' });

  try {
    const imageRef = await canvas.loadImage(referensiPath);
    const refCanvas = canvas.createCanvas(imageRef.width, imageRef.height);
    refCanvas.getContext('2d').drawImage(imageRef, 0, 0);
    const refDesc = await faceapi.computeFaceDescriptor(refCanvas);

    const selfieCanvas = await decodeBase64Image(photo);
    const selfieDesc = await faceapi.computeFaceDescriptor(selfieCanvas);

    const dist = faceapi.euclideanDistance(refDesc, selfieDesc);
    const match = dist < 0.45;

    res.json({ status: 'success', match });
  } catch (err) {
    console.error(err);
    res.status(500).json({ status: 'error', message: 'Gagal proses wajah' });
  }
});

const PORT = 5000;
app.listen(PORT, () => console.log(`🧠 Face recognition API ready on port ${PORT}`));
