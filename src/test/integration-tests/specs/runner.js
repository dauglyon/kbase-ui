/*global describe, it, browser, exports */

var fs = require('fs');

function load(file) {
    var contents = fs.readFileSync(__dirname + '/' + file);
    return JSON.parse(contents);
}

function buildAttribute(element) {
    if (element instanceof Array) {
        return element.map(function (element) {
            return buildAttribute(element);
        }).join('');
    } else {
        return '[data-kbase-' + element.type + '="' + element.value + '"]';
    }
}
function buildSelector(path) {
    return path.map(function (element) {
        return buildAttribute(element);
    }).join(' ');
}
function extend(path, elements) {
    var newPath = path.map(function (el) {
        return el;
    });
    elements.forEach(function (element) {
        newPath.push(element);
    });
    return newPath;
}

function runTest(test) {
    describe(test.description, function () {
        test.specs.forEach(function (spec) {
            it(spec.description, function () {
                browser.url('/');
                spec.tasks.forEach(function (task) {
                    if (task.selector) {
                        var selector = buildSelector(extend(spec.baseSelector, task.selector));
                        if (task.wait) {
                            browser.waitForExist(selector, task.wait);
                        } else if (task.exists) {
                            browser.isExisting(selector);
                        }
                        if (task.action) {
                            switch (task.action) {
                            case 'click':
                                browser.click(selector);
                                break;
                            default:
                                throw new Error('Unknown task action ' + task.action);
                            }
                        }
                    } else if (task.navigate) {
                        console.log('navigating to', task.navigate.path);
                        browser.url('#' + task.navigate.path);
                    }
                });
            });
        });
    });
}

function runTests(tests) {
    tests.forEach(function (test) {
        runTest(test);
    });
}

exports.runTests = runTests;
exports.load = load;