import { prepareMeasurements } from './investigation-summary.js';

self.onmessage = ({ data: { bundle, coverage, options } }) => {
  self.postMessage(prepareMeasurements(bundle, coverage, options));
};
