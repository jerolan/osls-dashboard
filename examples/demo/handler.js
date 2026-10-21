'use strict';

module.exports.hello = async (event) => {
  return {
    statusCode: 200,
    body: JSON.stringify({ message: 'hello from osls-console-demo', ts: Date.now() }),
  };
};

