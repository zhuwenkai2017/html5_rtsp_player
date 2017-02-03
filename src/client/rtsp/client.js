import {StateMachine} from 'bp_statemachine';
import {SDPParser} from '../../core/parsers/sdp';
import {RTSPStream} from './stream';
// import {RTP} from './rtp/rtp';
import RTPFactory from './rtp/factory';
import {MessageBuilder} from './message';
import {RTPPayloadParser} from './rtp/payload/parser';
import {BaseClient} from '../../core/base_client';
import {getTagged} from 'bp_logger';
import {PayloadType} from '../../core/defs';
import {base64ToArrayBuffer, hexToByteArray} from '../../core/util/binary';
import {AACParser} from '../../core/parsers/aac';

const LOG_TAG = "client:rtsp";
const Log = getTagged(LOG_TAG);

export class RTPError {
    constructor(message, file, line) {
        //super(message, file, line);
    }
}

export default class RTSPClient extends BaseClient {
    constructor(transport, options={flush: 200}) {
        super(transport, options);
        this.clientSM = new RTSPClientSM(this, transport);
        this.clientSM.ontracks = (tracks) => {
            this.eventSource.dispatchEvent('tracks', tracks);
            this.startStreamFlush();
        };
        this.sampleQueues={};
    }
    
    static streamType() {
        return 'rtsp';
    }

    setSource(url) {
        super.setSource(url);
        this.clientSM.setSource(url);
    }

    destroy() {
        this.clientSM.destroy();
        return super.destroy();
    }

    start() {
        super.start();
        this.transport.ready.then(()=> {
            this.clientSM.start();
        });
    }

    onData(data) {
        this.clientSM.onData(data);
    }

    onConnected() {
        this.clientSM.onConnected();
        super.onConnected();
    }

    onDisconnected() {
        super.onDisconnected();
        this.clientSM.onDisconnected();
    }
}

export class RTSPClientSM extends StateMachine {
    static get USER_AGENT() {return 'SFRtsp 0.3';}
    static get STATE_INITIAL() {return  1 << 0;}
    static get STATE_OPTIONS() {return 1 << 1;}
    static get STATE_DESCRIBE () {return  1 << 2;}
    static get STATE_SETUP() {return  1 << 3;}
    static get STATE_STREAMS() {return 1 << 4;}
    static get STATE_TEARDOWN() {return  1 << 5;}
    // static STATE_PAUSED = 1 << 6;

    constructor(parent, transport) {
        super();

        this.parent = parent;
        this.transport = transport;
        this.payParser = new RTPPayloadParser();
        this.rtp_channels = new Set();
        this.ontracks = null;

        this.reset();

        this.addState(RTSPClientSM.STATE_INITIAL,{
        }).addState(RTSPClientSM.STATE_OPTIONS, {
            activate: this.sendOptions,
            finishTransition: this.onOptions
        }).addState(RTSPClientSM.STATE_DESCRIBE, {
            activate: this.sendDescribe,
            finishTransition: this.onDescribe
        }).addState(RTSPClientSM.STATE_SETUP, {
            activate: this.sendSetup,
            finishTransition: this.onSetup
        }).addState(RTSPClientSM.STATE_STREAMS, {

        }).addState(RTSPClientSM.STATE_TEARDOWN, {
            activate: ()=>{
                this.started = false;
            },
            finishTransition: ()=>{
                return this.transitionTo(RTSPClientSM.STATE_INITIAL)
            }
        }).addTransition(RTSPClientSM.STATE_INITIAL, RTSPClientSM.STATE_OPTIONS)
            .addTransition(RTSPClientSM.STATE_INITIAL, RTSPClientSM.STATE_TEARDOWN)
            .addTransition(RTSPClientSM.STATE_OPTIONS, RTSPClientSM.STATE_DESCRIBE)
            .addTransition(RTSPClientSM.STATE_DESCRIBE, RTSPClientSM.STATE_SETUP)
            .addTransition(RTSPClientSM.STATE_SETUP, RTSPClientSM.STATE_STREAMS)
            .addTransition(RTSPClientSM.STATE_TEARDOWN, RTSPClientSM.STATE_INITIAL)
            // .addTransition(RTSPClientSM.STATE_STREAMS, RTSPClientSM.STATE_PAUSED)
            // .addTransition(RTSPClientSM.STATE_PAUSED, RTSPClientSM.STATE_STREAMS)
            .addTransition(RTSPClientSM.STATE_STREAMS, RTSPClientSM.STATE_TEARDOWN)
            // .addTransition(RTSPClientSM.STATE_PAUSED, RTSPClientSM.STATE_TEARDOWN)
            .addTransition(RTSPClientSM.STATE_SETUP, RTSPClientSM.STATE_TEARDOWN)
            .addTransition(RTSPClientSM.STATE_DESCRIBE, RTSPClientSM.STATE_TEARDOWN)
            .addTransition(RTSPClientSM.STATE_OPTIONS, RTSPClientSM.STATE_TEARDOWN);

        this.transitionTo(RTSPClientSM.STATE_INITIAL);

        this.shouldReconnect = false;

        // TODO: remove listeners
        // this.connection.eventSource.addEventListener('connected', ()=>{
        //     if (this.shouldReconnect) {
        //         this.reconnect();
        //     }
        // });
        // this.connection.eventSource.addEventListener('disconnected', ()=>{
        //     if (this.started) {
        //         this.shouldReconnect = true;
        //     }
        // });
        // this.connection.eventSource.addEventListener('data', (data)=>{
        //     let channel = new DataView(data).getUint8(1);
        //     if (this.rtp_channels.has(channel)) {
        //         this.onRTP({packet: new Uint8Array(data, 4), type: channel});
        //     }
        //
        // });
    }

    destroy() {
        this.parent = null;
    }

    setSource(url) {
        this.endpoint = url;
        this.url = url.urlpath;
    }

    onConnected() {
        if (this.rtpFactory) {
            this.rtpFactory = null;
        }
        if (this.shouldReconnect) {
            this.start();
        }
    }

    onDisconnected() {
        this.reset();
        this.shouldReconnect = true;
        return this.transitionTo(RTSPClientSM.STATE_TEARDOWN);
    }

    start() {
        if (this.state != RTSPClientSM.STATE_STREAMS) {
            this.transitionTo(RTSPClientSM.STATE_OPTIONS);
        } else {
            // TODO: seekable
        }
    }

    onData(data) {
        let channel = data[1];
        if (this.rtp_channels.has(channel)) {
            this.onRTP({packet: data.subarray(4), type: channel});
        }
    }

    useRTPChannel(channel) {
        this.rtp_channels.add(channel);
    }

    forgetRTPChannel(channel) {
        this.rtp_channels.delete(channel);
    }

    stop() {
        this.shouldReconnect = false;
        // this.mse = null;
    }

    reset() {
        this.methods = [];
        this.tracks = [];
        for (let stream in this.streams) {
            this.streams[stream].reset();
        }
        this.streams={};
        this.contentBase = "";
        this.state = RTSPClientSM.STATE_INITIAL;
        this.sdp = null;
        this.interleaveChannelIndex = 0;
        this.session = null;
        this.timeOffset = {};
    }

    reconnect() {
        //this.parent.eventSource.dispatchEvent('clear');
        this.reset();
        if (this.currentState.name != RTSPClientSM.STATE_INITIAL) {
            this.transitionTo(RTSPClientSM.STATE_TEARDOWN).then(()=> {
                this.transitionTo(RTSPClientSM.STATE_OPTIONS);
            });
        } else {
            this.transitionTo(RTSPClientSM.STATE_OPTIONS);
        }
    }

    supports(method) {
        return this.methods.includes(method)
    }

    parse(_data) {
        Log.debug(_data.payload);
        let d=_data.payload.split('\r\n\r\n');
        let parsed =  MessageBuilder.parse(d[0]);
        let len = Number(parsed.headers['content-length']);
        if (len) {
            let d=_data.payload.split('\r\n\r\n');
            parsed.body = d[1];
        } else {
            parsed.body="";
        }
        return parsed
    }

    sendRequest(_cmd, _host, _params={}, _payload=null) {
        this.cSeq++;
        Object.assign(_params, {
            CSeq: this.cSeq,
            'User-Agent': RTSPClientSM.USER_AGENT
        });
        if (_host != '*' && this.parent.endpoint.auth) {
            // TODO: DIGEST authentication
            _params['Authorization'] = `Basic ${btoa(this.parent.endpoint.auth)}`;
        }
        return this.send(MessageBuilder.build(_cmd, _host, _params, _payload));
    }

    send(_data) {
        return this.transport.ready.then(()=> {
            Log.debug(_data);
            return this.transport.send(_data).then(this.parse.bind(this)).then((parsed)=> {
                // TODO: parse status codes
                if (parsed.code>=300) {
                    Log.error(parsed.statusLine);
                    throw new Error(`RTSP error: ${parsed.code} ${parsed.message}`);
                }
                return parsed;
            });
        }).catch(this.onDisconnected.bind(this));
    }

    sendOptions() {
        this.reset();
        this.started = true;
        this.cSeq = 0;
        return this.sendRequest('OPTIONS', '*', {});
    }

    onOptions(data) {
        this.methods = data.headers['public'].split(',').map((e)=>e.trim());
        this.transitionTo(RTSPClientSM.STATE_DESCRIBE);
    }

    sendDescribe() {
        return this.sendRequest('DESCRIBE', this.url, {
            'Accept': 'application/sdp'
        }).then((data)=>{
            this.sdp = new SDPParser();
            return this.sdp.parse(data.body).catch(()=>{
                throw new Error("Failed to parse SDP");
            }).then(()=>{return data;});
        });
    }

    onDescribe(data) {
        this.contentBase = data.headers['content-base'] || `${this.endpoint.protocol}://${this.endpoint.location}${this.url}/`;
        this.tracks = this.sdp.getMediaBlockList();
        this.rtpFactory = new RTPFactory(this.sdp);

        Log.log('SDP contained ' + this.tracks.length + ' track(s). Calling SETUP for each.');

        if (data.headers['session']) {
            this.session = data.headers['session'];
        }

        if (!this.tracks.length) {
            throw new Error("No tracks in SDP");
        }

        this.transitionTo(RTSPClientSM.STATE_SETUP);
    }

    sendSetup() {
        let streams=[];

        // TODO: select first video and first audio tracks
        for (let track_type of this.tracks) {
            Log.log("setup track: "+track_type);
            // if (track_type=='audio') continue;
            // if (track_type=='video') continue;
            let track = this.sdp.getMediaBlock(track_type);
            if (!PayloadType.string_map[track.rtpmap[track.fmt[0]].name]) continue;

            this.streams[track_type] = new RTSPStream(this, track);
            let playPromise = this.streams[track_type].start();
            this.parent.sampleQueues[PayloadType.string_map[track.rtpmap[track.fmt[0]].name]]=[];
            streams.push(playPromise.then(({track, data})=>{
                let timeOffset = 0;
                try {
                    let rtp_info = data.headers["rtp-info"].split(';');
                    this.timeOffset[track.fmt[0]] = Number(rtp_info[rtp_info.length - 1].split("=")[1]) ;
                } catch (e) {
                    this.timeOffset[track.fmt[0]] = new Date().getTime();
                }

                let params = {
                    timescale: 0,
                    scaleFactor: 0
                };
                if (track.fmtp['sprop-parameter-sets']) {
                    let sps_pps = track.fmtp['sprop-parameter-sets'].split(',');
                    params = {
                        sps:base64ToArrayBuffer(sps_pps[0]),
                        pps:base64ToArrayBuffer(sps_pps[1])
                    };
                } else if (track.fmtp['config']) {
                    let config = track.fmtp['config'];
                    this.has_config = track.fmtp['cpresent']!='0';
                    let generic = track.rtpmap[track.fmt[0]].name == 'MPEG4-GENERIC';
                    if (generic) {
                        params={config:
                            AACParser.parseAudioSpecificConfig(hexToByteArray(config))
                        };
                        this.payParser.aacparser.setConfig(params.config);
                    } else if (config) {
                        // todo: parse audio specific config for mpeg4-generic
                        params={config:
                            AACParser.parseStreamMuxConfig(hexToByteArray(config))
                        };
                        this.payParser.aacparser.setConfig(params.config);
                    }
                }
                params.duration = this.sdp.sessionBlock.range?this.sdp.sessionBlock.range[1]-this.sdp.sessionBlock.range[0]:1;
                this.parent.seekable = (params.duration > 1);
                let res = {
                    track: track,
                    offset: timeOffset,
                    type: PayloadType.string_map[track.rtpmap[track.fmt[0]].name],
                    params: params,
                    duration: params.duration
                };
                return res;
            }));
        }
        return Promise.all(streams).then((tracks)=>{

            if (this.ontracks) {
                this.ontracks(tracks);
            }
        });
    }

    onSetup() {
        this.transitionTo(RTSPClientSM.STATE_STREAMS);
    }

    onRTP(_data) {
        if (!this.rtpFactory) return;

        let rtp = this.rtpFactory.build(_data.packet, this.sdp);
        rtp.timestamp -= this.timeOffset[rtp.pt];
        // Log.debug(rtp);
        if (rtp.media) {
            let pay = this.payParser.parse(rtp);
            if (pay) {
                this.parent.sampleQueues[rtp.type].push([pay]);
            }
        }

        // this.remuxer.feedRTP();
    }
}