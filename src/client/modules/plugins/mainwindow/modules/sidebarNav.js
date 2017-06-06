define([
    'bluebird',
    'kb_common/html'
], function (
    Promise,
    html
) {
    var t = html.tag,
        div = t('div'),
        a = t('a');

    function buildNavStripButton(cfg) {
        var icon = 'fa-' + cfg.icon;
        return a({
            href: '#' + cfg.path,
            class: '-nav-button',
            id: cfg.id,
            style: {
                width: '75px',
                textAlign: 'center',
                padding: '3px',
                margin: '6px 0',
                display: 'block',
                color: '#000',
                textDecoration: 'none'
            }
        }, [
            div({
                class: 'fa fa-3x ' + icon
            }),
            div({}, cfg.label)
        ]);
    }

    function factory(config) {
        var hostNode, container, runtime = config.runtime;

        var buttons = [{
            icon: 'dashboard',
            label: 'Dashboard',
            path: 'dashboard',
            authRequired: true
        }, {
            icon: 'book',
            label: 'Catalog',
            path: 'appcatalog',
            authRequired: false
        }, {
            icon: 'database',
            label: 'Import',
            path: 'bulk-ui',
            authRequired: true
        }, {
            //icon: 'user',
            icon: 'user-circle-o',
            label: 'Account',
            path: 'auth2/account',
            authRequired: true
        }];

        var currentButtons = [];
        var currentPath;

        function buildNavStrip(buttons) {
            var loggedIn = runtime.service('session').isLoggedIn();
            currentButtons = buttons
                .filter(function (button) {
                    if (button.authRequired && !loggedIn) {
                        return false;
                    }
                    return true;
                });
            return div({}, currentButtons
                .map(function (button) {
                    var id = html.genId();
                    button.id = id;
                    return buildNavStripButton(button);
                }));
        }

        function build(buttons) {
            return div({
                class: 'kb-mainWindow-sidebarNav',
                style: {
                    width: '75px'
                }
            }, buildNavStrip(buttons));
        }

        function render() {
            container.innerHTML = build(buttons);
        }

        function attach(node) {
            hostNode = node;
            container = hostNode;
        }

        function selectButton() {
            // var hash = window.location.hash;
            // if (!hash || hash.length === 0) {
            //     return;
            // }
            // var path = hash.substr(1);
            var path = currentPath;
            currentButtons.forEach(function (button) {
                var buttonNode = document.getElementById(button.id);
                //  var pathPrefix = path.substr(0, button.path.length);
                if (path === button.path) {
                    buttonNode.classList.add('-active');
                } else {
                    buttonNode.classList.remove('-active');
                }
            });
        }

        function setPath(route) {
            var path = [];
            var i;
            if (route.route.path) {
                for (i = 0; i < route.route.path.length; i += 1) {
                    var pathElement = route.route.path[i];
                    if (pathElement.type !== 'literal') {
                        break;
                    }
                    path.push(pathElement.value);
                }
            }
            currentPath = path.join('/');
        }

        function start(params) {
            return Promise.try(function () {
                render();
                runtime.recv('route', 'routing', function (route) {
                    setPath(route);
                    // TODO: route.route.path contains the parsed route.
                    // we should use it. But the session change event needs
                    // to evaluate the path as
                    selectButton();
                });

                runtime.recv('session', 'change', function (message) {
                    render();
                    selectButton();
                });
            });
        }

        function stop() {
            return null;
        }

        function detach() {
            // if (hostNode && container) {
            //     hostNode.removeChild(container);
            // }
            if (hostNode) {
                hostNode.innerHTML = '';
            }
        }

        return {
            attach: attach,
            start: start,
            stop: stop,
            detach: detach
        };
    }

    return {
        make: function (config) {
            return factory(config);
        }
    };
});