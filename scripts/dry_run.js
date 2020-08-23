let copydatasets = require('../js/common');

copydatasets.printFilesToCopy().then( () => {
  process.exit(0);
});