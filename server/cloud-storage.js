'use strict';

// cloud-storage.js — object storage on DigitalOcean Spaces (S3-compatible).
//
// Blobs live in Spaces (a separate, CDN-backed object store), NOT in the
// control-plane SQLite DB — keeping data.db small on the tight droplet. The
// backend_objects table keeps only metadata (bucket/path/bytes/etag/spaces_key);
// the bytes are written to / read from Spaces here.
//
// Configured via env (set in /opt/lingcode-api/.env):
//   SPACES_KEY, SPACES_SECRET   — Spaces access keypair
//   SPACES_ENDPOINT             — e.g. https://nyc3.digitaloceanspaces.com
//   SPACES_BUCKET               — the Space name
//   SPACES_REGION               — e.g. nyc3 (default us-east-1; Spaces ignores it)
//   SPACES_CDN_BASE             — optional CDN origin, e.g. https://cdn.lingcode.dev
//
// When unset, isConfigured() is false and the callers fall back to the legacy
// base64-in-SQLite path, so a server with no Spaces wiring still works.
//
// The @aws-sdk packages are lazy-required so the server boots even if they're
// not installed yet (mirrors cloud-data-plane's lazy-require of `pg`).

function env() {
  return {
    key: process.env.SPACES_KEY || '',
    secret: process.env.SPACES_SECRET || '',
    endpoint: process.env.SPACES_ENDPOINT || '',
    bucket: process.env.SPACES_BUCKET || '',
    region: process.env.SPACES_REGION || 'us-east-1',
    cdn: process.env.SPACES_CDN_BASE || '',
  };
}

function isConfigured() {
  const e = env();
  return !!(e.key && e.secret && e.endpoint && e.bucket);
}

let _client = null;
function client() {
  if (_client) return _client;
  const { S3Client } = require('@aws-sdk/client-s3');
  const e = env();
  _client = new S3Client({
    region: e.region,
    endpoint: e.endpoint,
    credentials: { accessKeyId: e.key, secretAccessKey: e.secret },
    forcePathStyle: false, // Spaces uses virtual-host style
  });
  return _client;
}

// Per-backend, per-bucket key prefix — never trust a client-supplied key.
// Drop empty / '.' / '..' segments so an object can never escape its prefix
// (real S3/Spaces treat keys as opaque, but a normalizing CDN might not).
function keyFor(backendId, bucket, path) {
  const safe = String(path).split('/').filter((seg) => seg && seg !== '.' && seg !== '..').join('/');
  return `be_${backendId}/${bucket}/${safe}`;
}

async function putObject(backendId, bucket, path, body, contentType) {
  const { PutObjectCommand } = require('@aws-sdk/client-s3');
  const e = env();
  const Key = keyFor(backendId, bucket, path);
  const out = await client().send(new PutObjectCommand({
    Bucket: e.bucket,
    Key,
    Body: body,
    ContentType: contentType || 'application/octet-stream',
    ACL: bucket === 'public' ? 'public-read' : 'private',
  }));
  return { key: Key, etag: (out && out.ETag) ? String(out.ETag).replace(/"/g, '') : null };
}

async function removeObject(backendId, bucket, path) {
  const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
  const e = env();
  await client().send(new DeleteObjectCommand({ Bucket: e.bucket, Key: keyFor(backendId, bucket, path) }));
}

// Stable public URL for a public-bucket object (served straight from Spaces /
// CDN — bytes never transit the droplet on read).
function publicUrl(backendId, bucket, path) {
  const e = env();
  const Key = keyFor(backendId, bucket, path);
  if (e.cdn) return `${e.cdn.replace(/\/+$/, '')}/${Key}`;
  const host = e.endpoint.replace(/^https?:\/\//, '');
  return `https://${e.bucket}.${host}/${Key}`;
}

// Short-lived signed GET URL for a private object.
async function presignGet(backendId, bucket, path, expiresIn) {
  const { GetObjectCommand } = require('@aws-sdk/client-s3');
  const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
  const e = env();
  return getSignedUrl(client(), new GetObjectCommand({ Bucket: e.bucket, Key: keyFor(backendId, bucket, path) }), { expiresIn: expiresIn || 900 });
}

// Short-lived signed PUT URL so a client uploads the bytes DIRECTLY to Spaces,
// never through the droplet. This is what makes GB-scale files possible (the
// base64 /storage/upload path is droplet-memory-bound). The ACL is signed in as
// an x-amz-acl header, so the client MUST send the same header on the PUT (see
// the returned headers in cloud-backend's create-upload-url). Spaces' single-PUT
// ceiling is 5 GB; beyond that needs multipart (out of scope here).
async function presignPut(backendId, bucket, path, contentType, expiresIn) {
  const { PutObjectCommand } = require('@aws-sdk/client-s3');
  const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
  const e = env();
  const acl = bucket === 'public' ? 'public-read' : 'private';
  const ct = contentType || 'application/octet-stream';
  const url = await getSignedUrl(client(), new PutObjectCommand({
    Bucket: e.bucket,
    Key: keyFor(backendId, bucket, path),
    ACL: acl,
    ContentType: ct,
  }), { expiresIn: expiresIn || 900 });
  // The headers the client must replay on its PUT (must match what we signed).
  return { url, headers: { 'x-amz-acl': acl, 'Content-Type': ct } };
}

// Read back an object's true size / etag / content-type after a direct PUT, so
// the server can record accurate metadata and enforce the size cap without ever
// having seen the body. Returns null if the object isn't there.
async function headObject(backendId, bucket, path) {
  const { HeadObjectCommand } = require('@aws-sdk/client-s3');
  const e = env();
  try {
    const out = await client().send(new HeadObjectCommand({ Bucket: e.bucket, Key: keyFor(backendId, bucket, path) }));
    return {
      bytes: Number(out.ContentLength || 0),
      etag: out.ETag ? String(out.ETag).replace(/"/g, '') : null,
      contentType: out.ContentType || null,
      key: keyFor(backendId, bucket, path),
    };
  } catch (_) { return null; }
}

// Delete EVERY object for a backend (all buckets, all users) under its be_<id>/
// key prefix. Called when a backend is deleted so we stop paying for orphaned
// bytes. Lists + batch-deletes 1000 keys per request; returns the count removed.
async function removePrefix(backendId) {
  const { ListObjectsV2Command, DeleteObjectsCommand } = require('@aws-sdk/client-s3');
  const e = env();
  const Prefix = `be_${backendId}/`;
  let removed = 0, ContinuationToken;
  do {
    const list = await client().send(new ListObjectsV2Command({ Bucket: e.bucket, Prefix, ContinuationToken }));
    const objs = (list.Contents || []).map((o) => ({ Key: o.Key }));
    if (objs.length) {
      await client().send(new DeleteObjectsCommand({ Bucket: e.bucket, Delete: { Objects: objs, Quiet: true } }));
      removed += objs.length;
    }
    ContinuationToken = list.IsTruncated ? list.NextContinuationToken : undefined;
  } while (ContinuationToken);
  return removed;
}

module.exports = { isConfigured, putObject, removeObject, removePrefix, publicUrl, presignGet, presignPut, headObject, keyFor };
