import { prepareAgentHandoff } from './agent-handoff.js';

self.onmessage = ({ data }) => {
  try {
    const result = prepareAgentHandoff(data.input, data.options);
    self.postMessage({ id: data.id, result });
  } catch (error) {
    self.postMessage({ id: data.id, error: { name: error.name, message: error.message, code: error.code, paths: error.paths, repair: error.repair } });
  }
};
