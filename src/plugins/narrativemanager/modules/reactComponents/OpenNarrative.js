define([
    'preact',
    'htm',

    'bootstrap'
], (
    preact,
    htm
) => {
    'use strict';

    const {h, Component } = preact;
    const html = htm.bind(h);

    class OpenNarrative extends Component {
        componentDidMount() {
            this.props.runtime.send('app', 'redirect', {
                url: this.props.url,
                new_window: false
            });
        }
        render() {
            return html`
                <div>
                    <p>
                    Opening your Narrative.
                    </p>
                    <p>
                    If the Narrative did not open, use this link:
                    </p>
                    <p>
                        <a href=${this.props.url} target="_blank">
                            Open your Narrative: ${this.props.url}
                        </a>
                    </p>
                </div>
            `;
        }
    }

    return OpenNarrative;
});