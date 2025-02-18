const zlib = require('zlib');
const Debug = require('debug');
const crypto = require('crypto');
const https = require('https');
const url = require('url');
const fs = require('mz/fs');
const temporary = require('temporary');
const promiseRetry = require('promise-retry');
const { createLogger } = require('./log');
const _ = require('lodash');
const pipe = require('promisepipe');
const { Transform } = require('stream');

let log = createLogger({ source: 'uploadToS3' });
let debug = Debug('taskcluster-docker-worker:uploadToS3');

// Upload an S3 artifact to the queue for the given taskId/runId.  Source can be
// a string or a stream.
module.exports = async function uploadToS3 (
  queue,
  taskId,
  runId,
  source,
  artifactName,
  expiration,
  httpsHeaders,
  putUrl,
  httpOptions,
  compress)
{
  let tmp = new temporary.File();
  debug(`created temporary file $${tmp.path} for ${artifactName}`);

  let logDetails = { taskId, runId, artifactName };
  let digest;
  let size;

  try {
    // Create a transform stream so that we can hash the original file as we
    // read it from the source stream
    let hash = crypto.createHash('sha256');
    let hashingTransform = new Transform({
      transform(chunk, encoding, callback) {
        hash.update(chunk);
        this.push(chunk);
        callback();
      },
    });

    // write the source out to a temporary file so that it can be
    // re-read into the request repeatedly
    if (typeof source === 'string') {
      tmp.writeFileSync(source);
      hash.update(source);
    } else {
      let stream = fs.createWriteStream(tmp.path);
      if (compress) {
        let gzip = zlib.createGzip();
        debug(`compressing to ${artifactName} to ${tmp.path}`);
        await pipe(source, hashingTransform, gzip, stream);
        debug(`compressed ${gzip.bytesWritten} bytes`);
      } else {
        await pipe(source, hashingTransform, stream);
      }
    }
    let stat = await fs.stat(tmp.path);
    size = stat.size;
    httpsHeaders['content-length'] = size;

    debug(`wrote ${size} bytes of source file to ${tmp.path} for ${artifactName}`);

    if (!putUrl) {
      let artifact = await queue.createArtifact(
        taskId,
        runId,
        artifactName,
        {
          // Why s3? It's currently cheaper to store data in s3 this could easily
          // be used with azure simply by changing s3 -> azure.
          storageType: 's3',
          expires: new Date(expiration),
          contentType: httpsHeaders['content-type'],
        },
      );

      putUrl = artifact.putUrl;
    }

    logDetails.putUrl = putUrl;

    let parsedUrl = url.parse(putUrl);
    let options = _.defaults({
      hostname: parsedUrl.hostname,
      path: parsedUrl.path,
      method: 'PUT',
      headers: httpsHeaders,
      port: parsedUrl.port,
    }, httpOptions);

    // promiseRetry defaults to 10 attempts before failing
    await promiseRetry((retry, number) => {
      if (number > 1) { // if it's not the first attempt
        log('retrying artifact upload', _.defaults({}, logDetails, {
          attemptNumber: number,
        }));
      }

      return new Promise((accept, reject) => {
        let req = https.request(options);

        req.on('response', (response) => {
          // Flush the data from the reponse so it's not held in memory
          response.resume();

          if (response.statusCode !== 200) {
            reject(new Error(
              `Could not upload artifact. Status Code: ${response.statusCode}`,
            ));
          } else {
            digest = hash.digest('hex');
            logDetails.hash = digest;
            accept();
          }
        });

        req.on('error', err => {
          log(`Error uploading ${artifactName}`, _.defaults({ err }, logDetails));
          reject(err);
        });

        req.setTimeout(5 * 60 * 1000, reject);

        const readStream = fs.createReadStream(tmp.path);
        readStream.on('error', err => {
          log(`Error reading temp file while uploading ${artifactName}`, _.defaults({ err }, logDetails));
          reject(err);
        });

        log(`Uploading ${artifactName}`, logDetails);
        readStream.pipe(req);
      }).catch(retry);
    // The formula to calculate the next attempt timeout is:
    // Math.min(random * minTimeout * Math.pow(factor, attempt), maxTimeout)
    // We have:
    //  maxTimeout = 30 seconds
    //  minTimeout = 1 second
    //  10 attempts
    //  random factor = 1..2
    // The first parameter of the min function can have a maximum value of
    //  2 * 1000 * Math.pow(factor, 10)
    // This value is bounded by maxTimeout. To avoid early saturation of the
    // calculated value, we must choose a value for factor that in the worst
    // case scenario should not be greater than maxTimeout, i.e.:
    //  2 * 1000 * Math.pow(factor, 10) <= 30000
    // Solving the equation for factor gives factor=1.311
    }, { maxTimeout: 30000, factor: 1.311, randomize: true });
  } finally {
    tmp.unlinkSync();
  }

  return { digest, size };
};
