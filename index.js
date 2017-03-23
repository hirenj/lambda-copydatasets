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
  }).catch( err => {
      if (err.statusCode == 403) {
        return {'sources' : []};
      }
      console.log('Error in getObject for conf ',{'Bucket' : bucket_name, 'Key' : config_key });
      throw err;
  });
};

const make_target_key = function(source,group) {
  source = source.replace('/','_').replace(/\.json$/,'').replace(/\.msdata$/,'');
  let source_components = source.split('_');
  if (source_components[0] === source_components[1]) {
    source_components.shift();
  }
  source = source_components.join('_');
  let sanitised_source = source.replace('-','_').replace(/[^A-Za-z0-9_]/g,'');
  return `uploads/${sanitised_source}/${group}`;
};

const list_keys = function(params) {
  let object_data = (params.Contents || [] ).map( key => {
    return { Key: key.Key, etag: key.ETag, modified: key.LastModified };
  });
  if (params.Bucket || (params.isTruncated && params.NextContinuationToken)) {
    let new_params = {
      Bucket : params.Bucket || params.Name,
      ContinuationToken: params.NextContinuationToken,
      Prefix : 'uploads/'
    };
    if (params.Bucket) {
      delete params.ContinuationToken;
    }
    return s3.listObjectsV2(new_params).promise().then( list_keys ).then( (new_objects) => {
      object_data = object_data.concat(new_objects);
      return object_data;
    }).catch( err => {
      console.log('Error in listobjects',new_params);
      throw err;
    });
  }
  return object_data;
};

const current_keys = list_keys({Bucket: bucket_name }).then( (keys) => {
  let mapping = {};
  keys.forEach( key => mapping[key.Key] = key.modified );
  return mapping;
});

const copy_keys = function(groups,etag_map,keys) {
  let copy_promises = [];
  let source_bucket = keys.Name;
  (keys.Contents || []).forEach( key => {
    let source_key = key.Key;

    if (source_key.match(/\/$/)) {
      return;
    }

    copy_promises = copy_promises.concat( groups.map( target_group => {
      let target_key = make_target_key(source_key,target_group);
      let params = { Bucket: bucket_name, Key: target_key, CopySource: source_bucket+'/'+source_key };
      if (etag_map[target_key]) {
        params.CopySourceIfModifiedSince = etag_map[target_key];
        if (key.LastModified > etag_map[target_key]) {
          console.log('Modified dates do not match for ',target_key,key.LastModified,etag_map[target_key]);
        }
      }
      return s3.copyObject(params).promise()
      .then( () => console.log('Copied',params.CopySource, 'to',target_key))
      .catch( err => {
        if (err.statusCode == 412) {
          console.log('Modified dates match for ',target_key,key.LastModified,etag_map[target_key]);
          return;
        }
        throw err;
      })
      .then( () => delete etag_map[target_key] )
      .catch( err => {
        console.log('Error in copyObject',params);
        throw err;
      });
    }));
  });
  if (keys.Bucket || (keys.isTruncated && keys.NextContinuationToken)) {
    let params = {
      Bucket: keys.Bucket || keys.Name,
      Prefix: keys.Prefix,
      ContinuationToken: keys.NextContinuationToken
    };
    if (keys.Bucket) {
      delete params.ContinuationToken;
    }
    return s3.listObjectsV2(params).promise().then( copy_keys.bind(null,groups,etag_map) ).then( (new_promises) => {
      return copy_promises.concat(new_promises);
    }).catch( err => {
      console.log('Error in listobjects',params);
      throw err;
    });
  }
  return copy_promises;
};

const remove_keys = function(keys) {
  let params = { Bucket: bucket_name,
                 Delete : {} };
  console.log(keys.length,'keys to remove');
  if (keys.length < 1 ) {
    return Promise.resolve();
  }
  params.Delete.Objects = keys.map( key => { return { Key: key }; });
  return s3.deleteObjects(params).promise();
};

const handle_sources = function(sources,idx) {
  let source = sources[idx];
  if ( ! source ) {
    return current_keys.then( etag_map => {
      let source_keys = sources.map( source => source.key.replace('-','_').replace(/[^A-Za-z0-9_]/g,'_').replace(/_$/,'') );
      console.log(Object.keys(etag_map));
      console.log(source_keys);
      let remaining_keys = Object.keys(etag_map).filter( key => {
        key = key.replace(/^uploads\//,'');
        let matching_sources = source_keys.filter( prefix => {
          return key.indexOf(prefix) == 0;
        });
        return matching_sources.length > 0;
      });
      console.log("Remaining keys after filtering by source");
      console.dir(remaining_keys);
      return remove_keys(remaining_keys);
    });
  }
  let bucket = source.bucket;
  let key = source.key;
  let groups = source.groups;
  return current_keys.then( etag_map => {
    return copy_keys(groups, etag_map, { Bucket: bucket, Prefix: key }).then( (copy_promises) => {
      return Promise.all(copy_promises);
    }).then( () => handle_sources(sources,idx+1) );
  });
};

const extract_changed_keys = function(event) {
  if ( ! event.Records ) {
    return [];
  }
  let results = event.Records
  .filter( rec => rec.Sns )
  .map( rec => {
    let sns_message = JSON.parse(rec.Sns.Message);
    return sns_message.Records.map( sns_rec => sns_rec.s3 ).map( s3 => {
      return { bucket : s3.bucket.name, key: s3.object.key };
    });
  });
  results = [].concat.apply([],results);
  return results.filter( obj => obj.bucket == bucket_name ).map( obj => obj.key );
};

const copyDatasets = function(event,context) {
  let changed_keys = extract_changed_keys(event);

  // If we have changed files (as extracted from the SNS message from the subscribed topic)
  // we should check to make sure that the file that triggered this execution was
  // our config file

  if (changed_keys.length > 0 && changed_keys.indexOf(config_key) < 0) {
    console.log(`Skipping execution since ${config_key} was not modified`);
    context.succeed('OK');
    return;
  }

  get_config().then( conf => {
    console.log('Data synchronisation parameters',conf.sources);
    return handle_sources(conf.sources,0);
  }).then( () => {
    context.succeed('OK');
  }).catch( err => {
    console.error(err);
    console.error(err.stack);
    context.fail('NOT-OK');
  });
};

exports.copyDatasets = copyDatasets;