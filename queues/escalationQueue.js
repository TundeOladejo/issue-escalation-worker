const { Queue } = require('bullmq');
const Redis = require('ioredis');

const connection = new Redis(process.env.REDIS_URL);

const escalationQueue = new Queue('escalationQueue', { connection });

module.exports = escalationQueue;
