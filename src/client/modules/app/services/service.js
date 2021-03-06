define([
    'bluebird'
], function (
    Promise
) {

    return class Service {
        constructor({runtime}) {
            this.runtime = runtime;
        }

        pluginHandler(serviceConfigs) {
            console.warn('some plugin using service service!!', serviceConfigs);
            return Promise.try(() => {
                const services = serviceConfigs.map((serviceConfig) => {
                    try {
                        this.runtime.addService(serviceConfig.name, {
                            runtime: this.runtime,
                            module: serviceConfig.module
                        });
                    } catch (ex) {
                        console.error('** ERROR ** ');
                        console.error(ex);
                    }
                    return this.runtime.loadService(serviceConfig.name);
                });
                return Promise.all(services);
            });
        }

        start() {
            return Promise.resolve();
        }

        stop() {
            return Promise.resolve();
        }
    };
});