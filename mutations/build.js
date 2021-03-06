/*
 * MUTANT
 * Not a build system, a mutation machine.
 *
 */

/*
 * Here is the idea of mutant. It decomposes the build process into a map of mutation
 * machines. The initial raw material + inputs enters the first process, which
 * works on it, then passes it to a second, and so forth.
 *
 * The main ideas are:
 * - the system travels between processes, does not exist anywhere else.
 * - each process may mutate the system, and must pass those mutations to
 *   the next process.
 * - processes are just javascript, so may include conditional branching, etc.
 * - procsses are asynchronous by nature, promises, so may arbitrarily contain
 *   async tasks, as long as they adhere to the promises api.
 *
 */

/*eslint-env node */
/*eslint strict: ["error", "global"], no-console: 0 */
'use strict';

const Promise = require('bluebird'),
    fs = Promise.promisifyAll(require('fs-extra')),
    path = require('path'),
    pathExists = require('path-exists'),
    mutant = require('./mutant'),
    yaml = require('js-yaml'),
    glob = Promise.promisify(require('glob').Glob),
    exec = require('child_process').exec,
    util = require('util'),
    handlebars = require('handlebars'),
    numeral = require('numeral'),
    tar = require('tar');

// UTILS
function run(command, ignoreStdErr = false, verbose = false) {
    return new Promise(function (resolve, reject) {
        const proc = exec(command, {}, function (err, stdout, stderr) {
            if (err) {
                reject(err);
            }
            if (stderr && !ignoreStdErr) {
                console.error('RUN error:', stderr);
                reject(new Error(stderr));
            }
            resolve(stdout);
        });
        if (verbose) {
            return proc.stdout.pipe(process.stdout);
        }
        return proc;
    });
}

function gitClone(url, dest, branch = 'master') {
    const commandLine = ['git clone --quiet --depth 1', '--branch', branch, url, dest].join(' ');
    console.log('git cloning...', commandLine);
    return run(commandLine, true);
}

function gitInfo(state) {
    // fatal: no tag exactly matches 'bf5efa0810d9f097b7c6ba8390f97c008d98d80e'
    return Promise.all([
        run('git show --format=%H%n%h%n%an%n%at%n%cn%n%ct%n%d --name-status | head -n 8'),
        run('git log -1 --pretty=%s'),
        run('git log -1 --pretty=%N'),
        run('git config --get remote.origin.url'),
        run('git rev-parse --abbrev-ref HEAD'),
        run('git describe --exact-match --tags $(git rev-parse HEAD)').catch(function () {
            // For non-prod ui we can be tolerant of a missing version, but not for prod.
            if (state.buildConfig.release) {
                throw new Error('This is a release build, a semver tag is required');
            }
            mutant.log('Not on a tag, but that is ok since this is not a release build');
            mutant.log('version will be unavailable in the ui');
            return '';
        })
    ]).spread(function (infoString, subject, notes, url, branch, tag) {
        var info = infoString.split('\n');
        var version;
        tag = tag.trim('\n');
        if (/^fatal/.test(tag)) {
            version = null;
        } else {
            var m = /^v([\d]+)\.([\d]+)\.([\d]+)$/.exec(tag);
            if (m) {
                version = m.slice(1).join('.');
            } else {
                version = null;
            }
        }

        // in Travis, the origin url may end in .git, remove it if so.
        // another way, but more can go wrong...
        // let [_m, originUrl] = url.match(/^(https:.+?)(?:[.]git)?$/) || [];

        url = url.trim('\n');
        if (url.endsWith('.git')) {
            url = url.slice(0, -4);
        }

        return {
            commitHash: info[0],
            commitAbbreviatedHash: info[1],
            authorName: info[2],
            authorDate: new Date(parseInt(info[3]) * 1000).toISOString(),
            committerName: info[4],
            committerDate: new Date(parseInt(info[5]) * 1000).toISOString(),
            reflogSelector: info[6],
            subject: subject.trim('\n'),
            commitNotes: notes.trim('\n'),
            originUrl: url,
            branch: branch.trim('\n'),
            tag: tag,
            version: version
        };
    });
}

// SUB TASKS

function dirList(dir) {
    return fs
        .readdirAsync(dir.join('/'))
        .then(function (files) {
            return files.map(function (file) {
                return dir.concat([file]);
            });
        })
        .then(function (files) {
            return Promise.all(
                files.map(function (file) {
                    return fs.statAsync(file.join('/')).then(function (stats) {
                        return {
                            stats: stats,
                            path: file
                        };
                    });
                })
            );
        })
        .then(function (files) {
            return files.filter(function (file) {
                return file.stats.isDirectory();
            });
        });
}

function fetchPluginsFromGithub(state) {
    // Load plugin config
    var root = state.environment.path,
        pluginConfig,
        pluginConfigFile = root.concat(['config', 'plugins.yml']).join('/'),
        gitDestination = root.concat(['gitDownloads']);

    return fs
        .mkdirsAsync(gitDestination.join('/'))
        .then(() => {
            return Promise.all([fs.readFileAsync(pluginConfigFile, 'utf8')]);
        })
        .spread(function (pluginFile) {
            pluginConfig = yaml.safeLoad(pluginFile);
        })
        .then(function () {
            // First generate urls to all the plugin repos.
            const githubPlugins = pluginConfig.plugins
                .filter(function (plugin) {
                    return (typeof plugin === 'object' && !plugin.internal && plugin.source.github);
                });
            return Promise.each(githubPlugins, (plugin) => {
                const repoName = plugin.source.github.name || plugin.globalName,
                    version = plugin.version,
                    branch = plugin.source.github.branch || (version ? 'v' + version : null),
                    gitAccount = plugin.source.github.account || 'kbase',
                    url = plugin.source.github.url || 'https://github.com/' + gitAccount + '/' + repoName;

                const dest = gitDestination.concat([plugin.name]).join('/');
                mutant.log(`... cloning plugin repo ${plugin.globalName}, version ${version}, branch: ${branch}`);
                return gitClone(url, dest, branch);
            });
        });
}

/*
 *
 * Create the plugins load config from the plugins master config. The load config
 * just lists the plugins to be loaded. The master config also provides the locations
 * for external plugins.
 */
function injectPluginsIntoConfig(state) {
    // Load plugin config
    var root = state.environment.path,
        configPath = root.concat(['build', 'client', 'modules', 'config']),
        pluginConfigFile = root.concat(['config', 'plugins.yml']).join('/');

    return fs
        .ensureDirAsync(configPath.join('/'))
        .then(function () {
            return fs.readFileAsync(pluginConfigFile, 'utf8');
        })
        .then(function (pluginFile) {
            return yaml.safeLoad(pluginFile);
        })
        .then(function (pluginConfig) {
            var plugins = {};
            pluginConfig.plugins.forEach(function (pluginItem) {
                if (typeof pluginItem === 'string') {
                    plugins[pluginItem] = {
                        name: pluginItem,
                        directory: 'plugins/' + pluginItem,
                        disabled: false
                    };
                } else {
                    pluginItem.directory = 'plugins/' + pluginItem.name;
                    plugins[pluginItem.name] = pluginItem;
                }
            });

            // emulate the yaml file for now, or for ever.
            return fs.writeFileAsync(configPath.concat(['plugin.yml']).join('/'), yaml.safeDump({plugins: plugins}));
        });
}


function yarn(cmd, argv, options) {
    return new Promise(function (resolve, reject) {
        exec('yarn ' + cmd + ' ' + argv.join(' '), options, function (err, stdout, stderr) {
            if (err) {
                reject(err);
            }
            if (stderr) {
                // reject(new Error(stderr));
                resolve({
                    warnings: stderr
                });
            }
            resolve({
                result: stdout
            });
        });
    });
}

function yarnInstall(state) {
    var base = state.environment.path.concat(['build']);
    var packagePath = base.concat(['package.json']);
    return mutant
        .loadJson(packagePath)
        .then(function (packageConfig) {
            delete packageConfig.devDependencies;
            return mutant.saveJson(packagePath, packageConfig);
        })
        .then(function () {
            return yarn('install', ['--no-lockfile'], {
                cwd: base.join('/'),
                timeout: 300000
            });
        });
}



function copyFromNodeNodules(state) {
    var root = state.environment.path;

    return mutant.loadYaml(root.concat(['config', 'npmInstall.yml'])).then(function (config) {
        var copyJobs = [];

        config.npmFiles.forEach(function (cfg) {
            /*
                 The top level bower directory name is usually the name of the
                 package (which also is often also base of the sole json file name)
                 but since this is not always the case, we allow the dir setting
                 to override this.
                 */
            var dir = cfg.dir || cfg.name,
                sources,
                cwd,
                dest;
            if (!dir) {
                throw new Error(
                    'Either the name or dir property must be provided to establish the top level directory'
                );
            }

            /*
                 The source defaults to the package name with .js, unless the
                 src property is provided, in which case it must be either a single
                 or set of glob-compatible strings.*/
            if (cfg.src) {
                if (typeof cfg.src === 'string') {
                    sources = [cfg.src];
                } else {
                    sources = cfg.src;
                }
            } else if (cfg.name) {
                sources = [cfg.name + '.js'];
            } else {
                throw new Error('Either the src or name must be provided in order to have something to copy');
            }

            /*
                 Finally, the cwd serves as a way to dig into a subdirectory and use it as the
                 basis for copying. This allows us to "bring up" files to the top level of
                 the destination. Since we are relative to the root of this process, we
                 need to jigger that here.
                 */
            if (cfg.cwd) {
                if (typeof cfg.cwd === 'string') {
                    cfg.cwd = cfg.cwd.split(/,/);
                }
                cwd = ['build', 'node_modules', dir].concat(cfg.cwd);
            } else {
                cwd = ['build', 'node_modules', dir];
            }

            /*
                 The destination will be composed of 'node_modules' at the top
                 level, then the package name or dir (as specified above).
                 This is the core of our "thinning and flattening", which is part of the
                 point of this bower copy process.
                 In addition, if the spec includes a dest property, we will use that
                 */
            if (cfg.standalone) {
                dest = ['build', 'client', 'modules'].concat([cfg.name]);
            } else {
                dest = ['build', 'client', 'modules', 'node_modules'].concat([cfg.dir || cfg.name]);
            }

            sources.forEach(function (source) {
                copyJobs.push({
                    cwd: cwd,
                    src: source,
                    dest: dest
                });
            });
        });

        // Create and execute a set of promises to fetch and operate on the files found
        // in the above spec.
        return Promise.all(
            copyJobs.map(function (copySpec) {
                return glob(copySpec.src, {
                    cwd: state.environment.path.concat(copySpec.cwd).join('/'),
                    nodir: true
                })
                    .then(function (matches) {
                        // Do the copy!
                        return Promise.all(
                            matches.map((match) => {
                                const fromPath = state.environment.path
                                        .concat(copySpec.cwd)
                                        .concat([match])
                                        .join('/'),
                                    toPath = state.environment.path
                                        .concat(copySpec.dest)
                                        .concat([match])
                                        .join('/');
                                return fs.copy(fromPath, toPath, {});
                            })
                        );
                    })
                    .then(function () {
                        return state;
                    });
            })
        );
    });
}

/*
 * Copy plugins from the bower module installation directory into the plugins
 * directory. We _could_ reference plugins directly from the bower directory,
 * as we do for other bower-installed dependencies, but it seems to be easier
 * to keep track of (and to be able to manipulate) plugins if they are all
 * located in a single, well-defined location.
 *
 * @returns {undefined}
 */
function installPlugins(state) {
    // Load plugin config
    var root = state.environment.path,
        pluginConfig,
        pluginConfigFile = root.concat(['config', 'plugins.yml']).join('/');
    return (
        fs
            .readFileAsync(pluginConfigFile, 'utf8')
            .then(function (pluginFile) {
                pluginConfig = yaml.safeLoad(pluginFile);
                const plugins = pluginConfig.plugins;
                return Promise.all(
                    // Supports installing from gitDownloads (which are downloaded prior to this)
                    plugins
                        .filter(function (plugin) {
                            return typeof plugin === 'object' && plugin.source.github;
                        })
                        .map(function (plugin) {
                            const pluginDir = root.concat(['gitDownloads', plugin.name]);
                            const destDir = root.concat(['build', 'client', 'modules', 'plugins', plugin.name]);
                            let srcDir;
                            if (plugin.cwd) {
                                mutant.info(`${plugin.name}: plugin building from configured cwd: ${plugin.cwd}`);
                                const cwd = plugin.cwd.split('/');
                                srcDir = pluginDir.concat(cwd);
                            } else {
                                const distFile = pluginDir.concat(['dist.tgz']);
                                if (pathExists.sync(distFile.join('/'))) {
                                    mutant.info(`${plugin.name}: plugin installing from dist.tgz`);
                                    tar.extract({
                                        cwd: pluginDir.join('/'),
                                        file: distFile.join('/'),
                                        sync: true
                                    });
                                    srcDir = pluginDir.concat(['dist', 'plugin']);
                                } else {
                                    throw new Error('git plugin ${plugin.name} does not have an install method - neither cwd nor dist.tgz');
                                }
                            }

                            mutant.ensureDir(destDir);
                            return mutant.copyFiles(srcDir, destDir, '**/*');
                        })
                )
                    .then(function () {
                        // Supports installing from a directory
                        return Promise.all(
                            plugins
                                .filter(function (plugin) {
                                    return typeof plugin === 'object' && plugin.source.directory;
                                })
                                .map(function (plugin) {
                                    const cwds = plugin.cwd || 'dist/plugin',
                                        cwd = cwds.split('/'),
                                        // Our actual cwd is mutations, so we need to escape one up to the
                                        // project root.
                                        repoRoot = (plugin.source.directory.root &&
                                            plugin.source.directory.root.split('/')) || ['', 'kb', 'plugins'],
                                        source = repoRoot.concat([plugin.name]).concat(cwd),
                                        destination = root.concat([
                                            'build',
                                            'client',
                                            'modules',
                                            'plugins',
                                            plugin.name
                                        ]);
                                    mutant.ensureDir(destination);
                                    return mutant.copyFiles(source, destination, '**/*');
                                })
                        );
                    })
                    .then(function () {
                        // Supports internal plugins.
                        return Promise.all(
                            plugins
                                .filter(function (plugin) {
                                    return typeof plugin === 'string';
                                })
                                .map(function (plugin) {
                                    const source = root.concat(['plugins', plugin]),
                                        destination = root.concat(['build', 'client', 'modules', 'plugins', plugin]);
                                    mutant.ensureDir(destination);
                                    return mutant.copyFiles(source, destination, '**/*');
                                })
                        );
                    });
            })
            // now move the test files into the test dir
            .then(function () {
                // dir list of all plugins
                const pluginsPath = root.concat(['build', 'client', 'modules', 'plugins']);
                return dirList(pluginsPath).then((pluginDirs) => {
                    return Promise.each(pluginDirs, (pluginDir) => {
                        // Has integration tests?
                        const testDir = pluginDir.path.concat(['test']);
                        return pathExists(testDir.join('/')).then((exists) => {
                            const justDir = pluginDir.path[pluginDir.path.length - 1];
                            if (!exists) {
                                mutant.warn('plugin without tests: ' + justDir);
                            } else {
                                mutant.success('plugin with tests!  : ' + justDir);
                                const dest = root.concat(['test', 'integration-tests', 'specs', 'plugins', justDir]);
                                return fs.moveAsync(testDir.join('/'), dest.join('/'));
                            }
                        });
                    });
                });
            })
            .then(function () {
                return state;
            })
    );
}

// PROCESSES

/*
 * setupBuild
 *
 * Responsible for creating the basic build.
 *
 * The basic build may be deployed for development or distribution.
 *
 * The deployment process is separate and guided by the configuration input
 * into the overall build.
 *
 * The build setup is responsible for the initial juggling of files to represent
 * the rough state of the delivered system. Including
 *
 * - remove extraneous files
 * - move search into the client
 * - ??
 *
 * @param {type} state
 * @returns {Array}
 */
function setupBuild(state) {
    const root = state.environment.path;
    state.steps = [];
    return mutant
        .deleteMatchingFiles(root.join('/'), /.*\.DS_Store$/)
        .then(function () {
            // the client really now becomes the build!
            const from = root.concat(['src', 'client']),
                to = root.concat(['build', 'client']);
            return fs.moveAsync(from.join('/'), to.join('/'));
        })
        .then(function () {
            // the client really now becomes the build!
            const from = root.concat(['src', 'test']),
                to = root.concat(['test']);
            return fs.moveAsync(from.join('/'), to.join('/'));
        })
        // .then(function () {
        //     // the client really now becomes the build!
        //     const from = root.concat(['docs']),
        //         to = root.concat(['build', 'client', 'docs']);
        //     return fs.moveAsync(from.join('/'), to.join('/'));
        // })
        .then(function () {
            // the client really now becomes the build!
            const from = root.concat(['src', 'plugins']),
                to = root.concat(['plugins']);
            return fs.moveAsync(from.join('/'), to.join('/'));
        })
        .then(function () {
            return fs.moveAsync(
                root.concat(['package.json']).join('/'),
                root.concat(['build', 'package.json']).join('/')
            );
        })
        .then(function () {
            return fs.rmdirAsync(root.concat(['src']).join('/'));
        })
        .then(function () {
            mutant.log('Fetch plugins from github');
            return fetchPluginsFromGithub(state);
        })
        .then(function () {
            mutant.log('Inject Plugins Into Config');
            return injectPluginsIntoConfig(state);
        })
        .then(function () {
            return state;
        });
}

// function installNpmPackages(state) {
//     return npmInstall(state)
//         .then(function () {
//             return fs.remove(state.environment.path.concat(['build', 'package.json']).join('/'));
//         })
//         .then(function () {
//             return copyFromNpm(state);
//         })
//         .then(function () {
//             return state;
//         });
// }

function installYarnPackages(state) {
    return yarnInstall(state)
        .then(function () {
            return fs.remove(state.environment.path.concat(['build', 'package.json']).join('/'));
        })
        .then(function () {
            return copyFromNodeNodules(state);
        })
        .then(function () {
            return state;
        });
}

async function removeSourceMaps(state) {
    const dir = state.environment.path
        .concat(['build', 'client']);
    await mutant.removeSourceMappingCSS(dir);
    await mutant.removeSourceMappingJS(dir);
    return state;
}

/*
 *
 * Copy the ui configuration files into the build.
 * settings.yml
 */
function copyUiConfig(state) {
    const root = state.environment.path,
        releaseVersionConfig = root.concat(['config', 'release.yml']),
        configFiles = [releaseVersionConfig],
        configDest = root.concat(['build', 'client', 'modules', 'config']);

    return Promise.all(
        configFiles.map((file) => {
            return mutant.loadYaml(file);
        })
    )
        .then((configs) => {
            return mutant.mergeObjects([{}].concat(configs));
        })
        .then((mergedConfigs) => {
            state.mergedConfig = mergedConfigs;
            return mutant.saveYaml(configDest.concat(['ui.yml']), mergedConfigs);
        })
        .then(() => {
            return state;
        });
}

function createBuildInfo(state) {
    return gitInfo(state).then(function (gitInfo) {
        const root = state.environment.path,
            configDest = root.concat(['build', 'client', 'modules', 'config', 'buildInfo.yml']),
            buildInfo = {
                target: state.buildConfig.target,
                stats: state.stats,
                git: gitInfo,
                // disabled for now, all uname packages are failing!
                hostInfo: null,
                builtAt: new Date().getTime()
            };
        state.buildInfo = buildInfo;
        return mutant.saveYaml(configDest, {buildInfo: buildInfo}).then(function () {
            return state;
        });
    });
}

function getReleaseNotes(state, version) {
    // lives in release-notes/RELEASE_NOTES_#.#.#.md
    const root = state.environment.path;
    const releaseNotesPath = root.concat(['release-notes', 'RELEASE_NOTES_' + version + '.md']);
    return fs.readFileAsync(releaseNotesPath.join('/'), 'utf8').catch(function (err) {
        mutant.warn('release notes file not found: ' + releaseNotesPath.join('/'), err);
        return null;
    });
}

function verifyVersion(state) {
    return Promise.try(function () {
        if (!state.buildConfig.release) {
            mutant.log('In a non-prod build, release version not checked.');
            return;
        }

        const releaseVersion = state.mergedConfig.release.version;
        const gitVersion = state.buildInfo.git.version;

        if (!releaseVersion) {
            throw new Error('this is a release build, and the release version is missing.');
        }

        const semverRe = /\d+\.\d+\.\d+$/;
        const gitSemverRe = /^v\d+\.\d+\.\d+$/;

        if (!semverRe.test(releaseVersion)) {
            throw new Error(
                'on a release build, and the release version doesn\'t look like a semver tag: ' + releaseVersion
            );
        }
        mutant.success('good release version');

        if (!gitSemverRe.test(state.buildInfo.git.tag)) {
            throw new Error(
                'on a release build, and the git tag doesn\'t look like a semver tag: ' + state.buildInfo.git.tag
            );
        }
        mutant.success('good git tag version');

        if (releaseVersion === gitVersion) {
            mutant.success('release and git agree on version ' + releaseVersion);
        } else {
            throw new Error(
                'Release and git versions are different; release says "' +
                releaseVersion +
                '", git says "' +
                gitVersion +
                '"'
            );
        }
        return getReleaseNotes(state, releaseVersion).then(function (releaseNotesFile) {
            if (releaseNotesFile) {
                mutant.success('have release notes');
            } else {
                throw new Error(
                    'Release notes not found for this version ' + releaseVersion + ', but required for a release'
                );
            }
        });
    }).then(function () {
        return state;
    });
}

// TODO: the deploy will be completely replaced with a deploy script.
// For now, the deploy is still required for dev and ci builds to work
// without the deploy script being integrated into the ci, next, appdev, and prod
// environments.
// TODO: those environments WILL need to be updated to support redeployment.
/*
  The kbase-ui deploy config is the only part of the config which changes between
  environments. (In reality the ui target does also determine what "type" of
  ui is built.)
  It provides the service url base, analytics keys, feature filters, ui elements.
*/
/*
 * obsolete:
 * The standard kbase deploy config lives in the root, and is named deploy.cfg
 * We pick one of the pre-configured deploy config files based on the deploy
 * target key passed in and found on state.config.targets.kbDeployConfig
 */
function makeKbConfig(state) {
    const root = state.environment.path,
        // fileName = state.buildConfig.target + '.yml',
        deployModules = root.concat(['build', 'client', 'modules', 'deploy']);

    return (
        Promise.all([fs.mkdirsAsync(deployModules.join('/'))])
            .then(function () {
                // A bit weird to do this here...
                return fs
                    .readFileAsync(root.concat(['build', 'client', 'build-info.js.txt']).join('/'), 'utf8')
                    .then(function (template) {
                        const dest = root.concat(['build', 'client', 'build-info.js']).join('/');
                        const out = handlebars.compile(template)(state.buildInfo);
                        return fs.writeFileAsync(dest, out);
                    })
                    .then(function () {
                        fs.removeAsync(root.concat(['build', 'client', 'build-info.js.txt']).join('/'));
                    });
            })
            // Now merge the configs.
            .then(function () {
                const configs = [
                    // root.concat(['config', 'services.yml']),
                    root.concat(['build', 'client', 'modules', 'config', 'ui.yml']),
                    root.concat(['build', 'client', 'modules', 'config', 'buildInfo.yml'])
                ];
                return Promise.all(configs.map(mutant.loadYaml))
                    .then(function (yamls) {
                        const merged = mutant.mergeObjects(yamls);
                        const dest = root.concat(['build', 'client', 'modules', 'config', 'config.json']);
                        return mutant.saveJson(dest, merged);
                    })
                    .then(function () {
                        return Promise.all(
                            configs.map(function (file) {
                                fs.remove(file.join('/'));
                            })
                        );
                    });
            })
            .then(function () {
                return state;
            })
    );
}

function addCacheBusting(state) {
    const root = state.environment.path;
    return Promise.all(
        ['index.html', 'load-narrative.html'].map(function (fileName) {
            return Promise.all([
                fileName,
                fs.readFileAsync(root.concat(['build', 'client', fileName]).join('/'), 'utf8')
            ]);
        })
    )
        .then(function (templates) {
            return Promise.all(
                templates.map(function (template) {
                    const dest = root.concat(['build', 'client', template[0]]).join('/');
                    const out = handlebars.compile(template[1])(state);
                    return fs.writeFileAsync(dest, out);
                })
            );
        })
        .then(() => {
            return state;
        });
}

function makeDeployConfig(state) {
    const root = state.environment.path;
    const cfgDir = root.concat(['build', 'deploy', 'cfg']);
    const sourceDir = root.concat(['config', 'deploy']);

    // make deploy dir
    return fs
        .mkdirsAsync(cfgDir.join('/'))
        .then(function () {
            // read yaml an write json deploy configs.
            return glob(sourceDir.concat(['*.yml']).join('/'), {
                nodir: true
            });
        })
        .then(function (matches) {
            return Promise.all(
                matches.map(function (match) {
                    const baseName = path.basename(match);
                    return mutant.loadYaml(match.split('/')).then(function (config) {
                        mutant.saveJson(cfgDir.concat([baseName + '.json']), config);
                    });
                })
            );
        })
        .then(function () {
            return state;
        });

    // save the deploy script
}

function cleanup(state) {
    const root = state.environment.path;
    return fs.removeAsync(root.concat(['build', 'node_modules']).join('/'))
        .then(function () {
            return state;
        });
}

function makeBaseBuild(state) {
    const root = state.environment.path,
        buildPath = ['..', 'build'];

    return fs
        .removeAsync(buildPath.concat(['build']).join('/'))
        .then(function () {
            mutant.log('Copying config...');
            return fs.moveAsync(root.concat(['config']).join('/'), root.concat(['build', 'config']).join('/'));
        })
        .then(function () {
            mutant.log('Copying build...');
            return fs.copyAsync(root.concat(['build']).join('/'), buildPath.concat(['build']).join('/'));
        })
        .then(function () {
            mutant.log('Copying test...');
            return fs.copyAsync(root.concat(['test']).join('/'), buildPath.concat(['test']).join('/'));
        })
        .then(function () {
            return state;
        });
}

function fixupBaseBuild(state) {
    const root = state.environment.path,
        mapRe = /\/\*#\s*sourceMappingURL.*\*\//m;

    // remove mapping from css files.
    return glob(
        root
            .concat(['build', 'client', 'modules', '**', '*.css'], {
                ignore: ['iframe_root']
            })
            .join('/'),
        {
            nodir: true
        }
    )
        .then(function (matches) {
            return Promise.all(
                matches.map(function (match) {
                    return fs.readFileAsync(match, 'utf8').then(function (contents) {
                        // replace the map line with an empty string
                        if (!mapRe.test(contents)) {
                            return;
                        }
                        mutant.warn('Fixing up css file to remove mapping');
                        mutant.warn(match);

                        const fixed = contents.replace(mapRe, '');
                        return fs.writeFileAsync(match, fixed);
                    });
                })
            );
        })
        .then(function () {
            return state;
        });
}

/*
    copyToDistBuild
    Simply copies the build directory to the dist directory.
    This allows us to just rely upon whatever the current build target is to be in
    dist. The old way was to _use_ build for dev builds, and dist for others. Now
    dev uses dist as well.
*/
function copyToDistBuild(state) {
    const root = state.environment.path,
        buildPath = ['..', 'build'];

    return fs.copyAsync(root.concat(['build']).join('/'), buildPath.concat(['dist']).join('/')).then(function () {
        return state;
    });
}

function makeDistBuild(state) {
    const root = state.environment.path,
        buildPath = ['..', 'build'],
        uglify = require('uglify-es');

    return fs
        .copyAsync(root.concat(['build']).join('/'), root.concat(['dist']).join('/'))
        .then(function () {
            return glob(root.concat(['dist', 'client', 'modules', '**', '*.js']).join('/'), {
                nodir: true
            }).then(function (matches) {
                // TODO: incorporate a sustainable method for omitting
                // directories from alteration.
                // FORNOW: we need to protect iframe-based plugins from having
                // their plugin code altered.
                const reProtected = /\/modules\/plugins\/.*?\/iframe_root\//;
                const files = matches.filter(function (match) {
                    return !reProtected.test(match);
                });
                return Promise.all(files).mapSeries(function (match) {
                    return fs.readFileAsync(match, 'utf8').then(function (contents) {
                        // see https://github.com/mishoo/UglifyJS2 for options
                        // just overriding defaults here
                        const result = uglify.minify(contents, {
                            output: {
                                beautify: false,
                                max_line_len: 80,
                                quote_style: 0
                            },
                            compress: {
                                // required in uglify-es 3.3.10 in order to work
                                // around a bug in the inline implementation.
                                // it should be fixed in an upcoming release.
                                inline: 1
                            },
                            safari10: true
                        });

                        if (result.error) {
                            console.error('Error minifying file: ' + match, result);
                            throw new Error('Error minifying file ' + match) + ':' + result.error;
                        } else if (result.code.length === 0) {
                            mutant.warn('Skipping empty file: ' + match);
                        } else {
                            return fs.writeFileAsync(match, result.code);
                        }
                    });
                });
            });
        })
        .then(function () {
            // remove previously built dist.
            return fs.removeAsync(buildPath.concat(['dist']).join('/'));
        })
        .then(function () {
            // copy the new one there.
            return fs.copyAsync(root.concat(['dist']).join('/'), buildPath.concat(['dist']).join('/'));
        })
        .then(function () {
            return state;
        });
}

function makeModuleVFS(state, whichBuild) {
    const root = state.environment.path,
        buildPath = ['..', 'build'];

    return glob(root.concat([whichBuild, 'client', 'modules', '**', '*']).join('/'), {
        nodir: true,
        exclude: [[whichBuild, 'client', 'modules', 'deploy', 'config.json']]
    })
        .then(function (matches) {
            // just read in file and build a giant map...
            const vfs = {
                scripts: {},
                resources: {
                    json: {},
                    text: {},
                    csv: {},
                    css: {}
                }
            };
            const vfsDest = buildPath.concat([whichBuild, 'client', 'moduleVfs.js']);
            const skipped = {};

            function skip(ext) {
                if (!skipped[ext]) {
                    skipped[ext] = 1;
                } else {
                    skipped[ext] += 1;
                }
            }
            const included = {};

            function include(ext) {
                if (!included[ext]) {
                    included[ext] = 1;
                } else {
                    included[ext] += 1;
                }
            }

            function showStats(db) {
                Object.keys(db)
                    .map(function (key) {
                        return {
                            key: key,
                            count: db[key]
                        };
                    })
                    .sort(function (a, b) {
                        return b.count - a.count;
                    })
                    .forEach(function (item) {
                        mutant.log(item.key + ':' + item.count);
                    });
            }
            const exceptions = [/\/modules\/plugins\/.*?\/iframe_root\//];
            const cssExceptions = [/@import/, /@font-face/];
            const supportedExtensions = ['js', 'yaml', 'yml', 'json', 'text', 'txt', 'css'];
            return Promise.all(matches)
                .mapSeries(function (match) {
                    const relativePath = match.split('/').slice(root.length + 2);
                    const path = '/' + relativePath.join('/');

                    // exclusion based on path pattern
                    if (
                        exceptions.some(function (re) {
                            return re.test(path);
                        })
                    ) {
                        skip('excluded');
                        return;
                    }

                    const m = /^(.*)\.([^.]+)$/.exec(path);

                    // bare files we don't support
                    if (!m) {
                        skip('no extension');
                        mutant.warn('module vfs cannot include file without extension: ' + path);
                    }
                    const base = m[1];
                    const ext = m[2];

                    // skip if in unsupported extensions
                    if (supportedExtensions.indexOf(ext) === -1) {
                        skip(ext);
                        return;
                    }

                    return fs.statAsync(match).then(function (stat) {
                        if (stat.size > 200000) {
                            mutant.warn(
                                'omitting file from bundle because too big: ' + numeral(stat.size).format('0.0b')
                            );
                            mutant.warn('  ' + match);
                            mutant.warn('   don\'t worry, it is stil included in the build!');
                            skip('toobig');
                            return;
                        }
                        return fs.readFileAsync(match, 'utf8').then(function (contents) {
                            switch (ext) {
                            case 'js':
                                include(ext);
                                vfs.scripts[path] = 'function () { ' + contents + ' }';
                                break;
                            case 'yaml':
                            case 'yml':
                                include(ext);
                                vfs.resources.json[base] = yaml.safeLoad(contents);
                                break;
                            case 'json':
                                if (vfs.resources.json[base]) {
                                    throw new Error('duplicate entry for json detected: ' + path);
                                }
                                try {
                                    include(ext);
                                    vfs.resources.json[base] = JSON.parse(contents);
                                } catch (ex) {
                                    skip('error');
                                    console.error('Error parsing json file: ' + path + ':' + ex.message);
                                    // throw new Error('Error parsing json file: ' + path + ':' + ex.message);
                                }
                                break;
                            case 'text':
                            case 'txt':
                                include(ext);
                                vfs.resources.text[base] = contents;
                                break;
                            case 'css':
                                if (
                                    cssExceptions.some(function (re) {
                                        return re.test(contents);
                                    })
                                ) {
                                    skip('css excluded');
                                } else {
                                    include(ext);
                                    vfs.resources.css[base] = contents;
                                }
                                break;
                            case 'csv':
                                skip(ext);
                                break;
                            default:
                                skip(ext);
                            }
                        });
                    });
                })
                .then(function () {
                    mutant.log('vfs created');
                    mutant.log('skipped: ');
                    showStats(skipped);
                    mutant.log('included:');
                    showStats(included);
                    const modules =
                        '{' +
                        Object.keys(vfs.scripts)
                            .map(function (path) {
                                return '"' + path + '": ' + vfs.scripts[path];
                            })
                            .join(', \n') +
                        '}';
                    const script = [
                        'window.require_modules = ' + modules,
                        'window.require_resources = ' + JSON.stringify(vfs.resources, null, 4)
                    ].join(';\n');

                    fs.writeFileAsync(vfsDest.join('/'), script);
                });
        })
        .then(function () {
            return state;
        });
}

// STATE
// initial state
/*
 * filesystem: an initial set files files
 */

function main(type) {
    return (
        Promise.try(function () {
            mutant.log('Creating initial state for build: ' + type);
            const initialFilesystem = [
                {
                    cwd: ['..'],
                    path: ['src', 'client']
                },
                {
                    cwd: ['..'],
                    path: ['src', 'plugins']
                },
                // {
                //     cwd: ['..'],
                //     path: ['docs']
                // },
                {
                    cwd: ['..'],
                    path: ['src', 'test']
                },
                {
                    cwd: ['..'],
                    files: ['package.json']
                },
                {
                    cwd: ['..'],
                    path: ['release-notes']
                },
                {
                    cwd: ['..'],
                    path: ['config']
                }
            ];
            const buildControlConfigPath = ['..', 'config', 'build', 'configs', type + '.yml'];
            const buildControlDefaultsPath = ['..', 'config', 'build', 'defaults.yml'];
            const config = {
                initialFilesystem: initialFilesystem,
                buildControlConfigPath: buildControlConfigPath,
                buildControlDefaultsPath: buildControlDefaultsPath
            };
            return mutant.createInitialState(config);
        })

            .then(function (state) {
                return mutant.copyState(state);
            })
            .then(function (state) {
                mutant.log('Setting up build...');
                return setupBuild(state);
            })

            .then(function (state) {
                return mutant.copyState(state);
            })
            .then(function (state) {
                mutant.log('Installing YARN packages...');
                return installYarnPackages(state);
            })

            // Remove source mapping from the ui - do this before introducing
            // the plugins in order to simplify omitting those files.
            .then(function (state) {
                return mutant.copyState(state);
            })
            .then(function (state) {
                mutant.log('Removing source maps...');
                return removeSourceMaps(state);
            })


            .then(function (state) {
                return mutant.copyState(state);
            })
            .then(function (state) {
                mutant.log('Installing Plugins...');
                return installPlugins(state);
            })

            .then(function (state) {
                return mutant.copyState(state);
            })
            .then(function (state) {
                mutant.log('Copying config files...');
                return copyUiConfig(state);
            })

            .then(function (state) {
                return mutant.copyState(state);
            })
            .then(function (state) {
                mutant.log('Creating build record ...');
                return createBuildInfo(state);
            })

            // Here we verify that the verion stamp, release notes, and tag are consistent.
            // For prod we need to compare all three and fail the build if there is not a match.
            // For dev, we need to compare the stamp and release notes, not the tag.
            // At some future time when working solely off of master, we will be able to compare
            // to the most recent tag.
            .then(function (state) {
                return mutant.copyState(state);
            })
            .then(function (state) {
                mutant.log('Verifying version...');
                return verifyVersion(state);
            })

            .then(function (state) {
                return mutant.copyState(state);
            })
            .then(function (state) {
                mutant.log('Making KBase Config...');
                return makeKbConfig(state);
            })

            .then(function (state) {
                return mutant.copyState(state);
            })
            .then(function (state) {
                mutant.log('Making deploy configs');
                return makeDeployConfig(state);
            })

            .then(function (state) {
                return mutant.copyState(state);
            })
            .then(function (state) {
                mutant.log('Adding cache busting to html templates...');
                return addCacheBusting(state);
            })

            .then(function (state) {
                return mutant.copyState(state);
            })
            .then(function (state) {
                mutant.log('Cleaning up...');
                return cleanup(state);
            })

            // Fix up weird stuff
            .then(function (state) {
                return mutant.copyState(state);
            })
            .then(function (state) {
                mutant.log('Fixing up the base build...');
                return fixupBaseBuild(state);
            })

            // From here, we can make a dev build, make a release
            .then(function (state) {
                return mutant.copyState(state);
            })
            .then(function (state) {
                mutant.log('Making the base build...');
                return makeBaseBuild(state);
            })

            .then(function (state) {
                return mutant.copyState(state);
            })
            .then(function (state) {
                if (state.buildConfig.dist) {
                    mutant.log('Making the dist build...');
                    return makeDistBuild(state);
                } else {
                    return copyToDistBuild(state);
                }
            })

            .then(function (state) {
                return mutant.copyState(state);
            })
            .then(function (state) {
                const vfs = [];
                if (state.buildConfig.vfs && state.buildConfig.dist) {
                    vfs.push(makeModuleVFS(state, 'dist'));
                }
                return Promise.all(vfs).then(function () {
                    return state;
                });
            })
            .then(function (state) {
                return mutant.finish(state);
            })
    );
}

function usage() {
    console.error('usage: node build <config>');
}

const type = process.argv[2];

if (type === undefined) {
    console.error('Build config not specified');
    usage();
    process.exit(1);
}

main(type).catch((err) => {
    console.error('ERROR');
    console.error(err);
    console.error(
        util.inspect(err, {
            showHidden: false,
            depth: 10
        })
    );
    console.error(err.message);
    console.error(err.name);
    console.error(err.stack);
    process.exit(1);
});