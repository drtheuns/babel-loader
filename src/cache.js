/**
 * Filesystem Cache
 *
 * Given a file and a transform function, cache the result into files
 * or retrieve the previously cached files if the given file is already known.
 *
 * @see https://github.com/babel/babel-loader/issues/34
 * @see https://github.com/babel/babel-loader/pull/41
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");
const findCacheDir = require("find-cache-dir");
const { promisify } = require("util");

// Lazily instantiated when needed
let defaultCacheDirectory = null;

const readFile = promisify(fs.readFile);
const writeFile = promisify(fs.writeFile);
const gunzip = promisify(zlib.gunzip);
const gzip = promisify(zlib.gzip);
const makeDir = require("make-dir");

/**
 * @typedef {import('@babel/core').TransformOptions} TransformOptions
 * @typedef {import('@babel/core').BabelFileResult} BabelFileResult
 *
 * @typedef {{function(source: string, options: TransformOptions) => Promise<BabelFileResult>}} TransformFn
 *
 * @typedef {Object} CacheParameters
 * @property {string} cacheDirectory Directory to store cached files.
 * @property {string} cacheIdentifier Unique identifier to bust cache.
 * @property {boolean} cacheCompression Whether cached files should be compressed.
 * @property {string} source Original contents of the file to be cached.
 * @property {TransformOptions} options Options to be given to the transform function.
 * @property {TransformFn} transform
 */

/**
 * Read the contents from the compressed file.
 *
 * @async
 * @param {string} filename
 * @param {boolean} compress
 */
const read = async function (filename, compress) {
  const data = await readFile(filename + (compress ? ".gz" : ""));
  const content = compress ? await gunzip(data) : data;

  return JSON.parse(content.toString());
};

/**
 * Write contents into a compressed file.
 *
 * @async
 * @param {string} filename
 * @param {boolean} compress
 * @param {BabelFileResult} result
 */
const write = async function (filename, compress, result) {
  const content = JSON.stringify(result);

  const data = compress ? await gzip(content) : content;
  return await writeFile(filename + (compress ? ".gz" : ""), data);
};

/**
 * Build the filename for the cached file
 *
 * @param {string} source  File source code
 * @param {Object} options Options used
 *
 * @return {string}
 */
const filename = function (source, identifier, options) {
  const hash = crypto.createHash("md4");

  const contents = JSON.stringify({ source, options, identifier });

  hash.update(contents);

  return hash.digest("hex") + ".json";
};

/**
 * Handle the cache
 *
 * @param {string} directory
 * @param {CacheParameters} params
 */
const handleCache = async function (directory, params) {
  const {
    source,
    options = {},
    cacheIdentifier,
    cacheDirectory,
    cacheCompression,
    transform,
  } = params;

  const file = path.join(directory, filename(source, cacheIdentifier, options));

  try {
    // No errors mean that the file was previously cached
    // we just need to return it
    return await read(file, cacheCompression);
  } catch (err) {}

  const fallback =
    typeof cacheDirectory !== "string" && directory !== os.tmpdir();

  // Make sure the directory exists.
  try {
    await makeDir(directory);
  } catch (err) {
    if (fallback) {
      return handleCache(os.tmpdir(), params);
    }

    throw err;
  }

  // Otherwise just transform the file
  // return it to the user asap and write it in cache
  const result = await transform(source, options);

  try {
    await write(file, cacheCompression, result);
  } catch (err) {
    if (fallback) {
      // Fallback to tmpdir if node_modules folder not writable
      return handleCache(os.tmpdir(), params);
    }

    throw err;
  }

  return result;
};

/**
 * Retrieve file from cache, or create a new one for future reads
 *
 * @async
 * @param {CacheParameters} params
 *
 * @example
 *
 *   const result = await cache({
 *     cacheDirectory: '.tmp/cache',
 *     cacheIdentifier: 'babel-loader-cachefile',
 *     cacheCompression: false,
 *     source: *source code from file*,
 *     transform: require('babel-loader').transform,
 *     options: {
 *       experimental: true,
 *       runtime: true
 *     },
 *   });
 */
module.exports = async function (params) {
  let directory;

  if (typeof params.cacheDirectory === "string") {
    directory = params.cacheDirectory;
  } else {
    if (defaultCacheDirectory === null) {
      defaultCacheDirectory =
        findCacheDir({ name: "babel-loader" }) || os.tmpdir();
    }

    directory = defaultCacheDirectory;
  }

  return await handleCache(directory, params);
};
