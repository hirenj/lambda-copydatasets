let copydatasets = require('..');

copydatasets.printFilesToCopy().then( () => {
  process.exit(0);
});