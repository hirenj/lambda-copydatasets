'use strict';
/*jshint esversion: 6, node:true */

let config = {};

let bucket_name = 'data';

try {
  config = require('./resources.conf.json');
  bucket_name = config.buckets.dataBucket;
} catch (e) {
}

if (config.region) {
  require('lambda-helpers').AWS.setRegion(config.region);
}
const AWS = require('lambda-helpers').AWS;
const s3 = new AWS.S3();

const config_key = 'conf/copydatasets.json';

const get_config = function() {
  return s3.getObject({'Bucket' : bucket_name, 'Key' : config_key }).promise().then( (data) => {
    return JSON.parse(data.Body);
  });
};

const make_target_key = function(source,group) {
  let sanitised_source = source.replace('/','_').replace('\.json$').replace(/[^A-Za-z0-9_]/,'');
  return `uploads/${sanitised_source}/${group}`;
};

const copy_keys = function(groups,keys) {
  let copy_promises = [];
  let source_bucket = keys.Name;
  (keys.Contents || []).forEach( key => {
    let source_key = key.Key;
    let etag = key.ETag;
    copy_promises = copy_promises.concat( groups.map( target_group => {
      let target_key = make_target_key(source_key,target_group);
      let params = { Bucket: bucket_name, Key: target_key, CopySource: source_bucket+'/'+source_key };
      return s3.copyObject(params).promise().then( () => console.log("Copied ",params.CopySource));
    }));
  });
  if (keys.FirstRun || (keys.isTruncated && keys.NextContinuationToken)) {
    let params = {
      Bucket: keys.Bucket || keys.Name,
      Prefix: keys.Prefix,
      ContinuationToken: keys.NextContinuationToken
    };
    if (keys.FirstRun) {
      delete params.ContinuationToken;
    }
    return s3.listObjectsV2(params).promise().then( copy_keys.bind(null,groups) ).then( (new_promises) => {
      return copy_promises.concat(new_promises);
    });
  }
  return copy_promises;
};

const handle_sources = function(sources) {
  let source = (sources || []).shift();
  if ( ! source ) {
    return;
  }
  let bucket = source.bucket;
  let key = source.key;
  let groups = source.groups;
  return copy_keys(groups, {Name: bucket, Prefix: key, FirstRun: true }).then( (copy_promises) => {
    return Promise.all(copy_promises);
  }).then( () => handle_sources(null,sources) );
}

const copyDatasets = function(event,context) {
  get_config().then( conf => {
    console.log("Data synchronisation parameters");
    return handle_sources(conf.sources);
  }).then( () => {
    context.succeed('OK');
  }).catch( err => {
    console.error(err);
    console.error(err.stack);
    context.fail('NOT-OK');
  });
};

exports.copyDatasets = copyDatasets;