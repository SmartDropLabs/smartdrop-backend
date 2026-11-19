'use strict';

const jobs = {};

function registerJob(name, jobInstance) {
  jobs[name] = jobInstance;
}

function getJobs() {
  return jobs;
}

module.exports = {
  registerJob,
  getJobs,
};
