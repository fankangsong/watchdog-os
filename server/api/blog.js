/**
 * Blog 模块（BlogApp 数据源）：触发 static-gallary-generator 的 build.sh 构建静态站点。
 * 复用 runner.js 的脚本任务引擎（单槽锁 + 日志落盘/轮转/回读），
 * 仅日志文件（data/blog.log）与配置来源（cfg.blog）不同。
 * 脚本路径只来自服务端配置（.env 的 BLOG_SCRIPT），客户端不可传路径。
 */
'use strict';

const path = require('path');
const { cfg } = require('../config');
const { createScriptRunner } = require('./runner');

const engine = createScriptRunner({
  name: 'blog',
  logFile: path.join(__dirname, '..', '..', 'data', 'blog.log'),
  getConfig: () => cfg.blog,
});

module.exports = engine;
