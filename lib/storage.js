const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const provider = (process.env.STORAGE_PROVIDER || 'local').toLowerCase();
const bucket = process.env.S3_BUCKET || '';
const region = process.env.S3_REGION || 'us-east-1';
const endpoint = process.env.S3_ENDPOINT || '';
const accessKeyId = process.env.S3_ACCESS_KEY_ID || '';
const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY || '';

const s3Enabled = provider === 's3' && bucket && accessKeyId && secretAccessKey;
const uploadsDir = path.join(__dirname, '..', 'uploads');
fs.mkdirSync(uploadsDir, { recursive: true });

let s3Client = null;
if (s3Enabled) {
  s3Client = new S3Client({
    region,
    endpoint: endpoint || undefined,
    forcePathStyle: Boolean(endpoint),
    credentials: { accessKeyId, secretAccessKey },
  });
}

function safeFileName(name) {
  const base = path.basename(name).replace(/[^a-zA-Z0-9._-]/g, '_');
  return `${Date.now()}-${base}`;
}

async function saveUpload({ ticketId, originalName, mimeType, buffer }) {
  const filename = safeFileName(originalName);
  if (s3Enabled) {
    const key = `tickets/${ticketId}/${crypto.randomBytes(6).toString('hex')}-${filename}`;
    await s3Client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: buffer,
        ContentType: mimeType || 'application/octet-stream',
      }),
    );
    return { filename, storageProvider: 's3', storageKey: key, mimeType };
  }

  const ticketDir = path.join(uploadsDir, ticketId);
  fs.mkdirSync(ticketDir, { recursive: true });
  const diskPath = path.join(ticketDir, filename);
  await fs.promises.writeFile(diskPath, buffer);
  return { filename, storageProvider: 'local', storageKey: diskPath, mimeType };
}

async function getDownloadUrl(fileMeta, expirySeconds = 900) {
  if (!fileMeta) return null;
  if (fileMeta.storageProvider === 's3' && s3Enabled && fileMeta.storageKey) {
    const command = new GetObjectCommand({ Bucket: bucket, Key: fileMeta.storageKey });
    return getSignedUrl(s3Client, command, { expiresIn: expirySeconds });
  }
  return null;
}

module.exports = {
  getDownloadUrl,
  provider: s3Enabled ? 's3' : 'local',
  saveUpload,
  s3Enabled,
};
