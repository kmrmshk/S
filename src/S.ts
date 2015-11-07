/// <reference path="../S.d.ts" />

declare var module : { exports : {} };
declare var define : (deps: string[], fn: () => S) => void;

(function () {
    "use strict";
    
    // "Globals" used to keep track of current system state
    var Time      = 1,
        Batching  = 0,
        Batch     = [] as DataNode<any>[],
        Updating  = null as ComputationNode<any>,
        Disposing = false,
        Disposes  = [] as ComputationNode<any>[];
    
    var S = <S>function S<T>(fn : () => T) : () => T {
        var options = (this instanceof Builder ? this.options : null) as Options,
            parent  = Updating,
            gate    = (options && options.gate) || (parent && parent.gate) || null,
            node    = new ComputationNode<T>(fn, gate);

        if (parent && (!options || !options.toplevel)) {
            (parent.children || (parent.children = [])).push(node);
        }
            
        Updating = node;
        if (Batching) {
            if (options && options.static) {
                options.static();
                node.static = true;
            }
            node.value = fn();
        } else {
            node.value = initialExecution(node, fn, options && options.static);
        }
        Updating = parent;

        return function computation() {
            if (Disposing) {
                if (Batching) Disposes.push(node);
                else node.dispose();
            } else if (Updating && node.fn) {
                if (node.receiver && node.receiver.marks !== 0 && node.receiver.age === Time) {
                    backtrack(node.receiver);
                }
                if (!Updating.static) {
                    if (!node.emitter) node.emitter = new Emitter(node);
                    addEdge(node.emitter, Updating);
                }
            }
            return node.value;
        }
    }
    
    function initialExecution<T>(node : ComputationNode<T>, fn : () => T, on : () => any) {
        var result : T;
        
        Time++;
        Batching = 1;
            
        try {
            if (on) {
                on();
                node.static = true;
            }
            result = fn();
    
            if (Batching > 1) resolve(null);
        } finally {
            Updating = null;
            Batching = 0;
        }
        
        return result;
    }
        
    S.data = function data<T>(value : T) : (value? : T) => T {
        var node = new DataNode(value);

        return function data(value? : T) {
            if (arguments.length > 0) {
                if (Batching) {
                    if (node.age === Time) { // value has already been set once, check for conflicts
                        if (value !== node.pending) {
                            throw new Error("conflicting changes: " + value + " !== " + node.pending);
                        }
                    } else { // add to list of changes
                        node.age = Time; 
                        node.pending = value;
                        Batch[Batching++] = node;
                    }
                } else { // not batching, respond to change now
                    node.age = Time; 
                    node.value = value;
                    if (node.emitter) handleEvent(node);
                }
                return value;
            } else {
                if (Updating && !Updating.static) {
                    if (!node.emitter) node.emitter = new Emitter(null);
                    addEdge(node.emitter, Updating);
                }
                return node.value;
            }
        }
    };
    
    /// Options
    class Options {
        toplevel = false;
        gate     = null as (node : ComputationNode<any>) => boolean;
        static   = null as () => any;
    }
    
    class Builder {
        constructor(public options : Options) {}
        S(fn) { return S.call(this, fn); };
    }
    
    class AsyncOption extends Builder {
        async(fn : (go : () => void) => void | (() => void)) { 
            this.options.gate = gate(fn); 
            return new Builder(this.options); 
        }
    }
    
    class OnOption extends AsyncOption {
        on(/* ...fns */) {
            var args;
            
            if (arguments.length === 0) {
                this.options.static = noop;
            } else if (arguments.length === 1) {
                this.options.static = arguments[0];
            } else {
                args = Array.prototype.slice.call(arguments);
                this.options.static = callAll;
            }
            
            return new AsyncOption(this.options);
            
            function callAll() { for (var i = 0; i < args.length; i++) args[i](); }
            function noop() {}
        }
    }

    S.toplevel = function toplevel() {
        var options = new Options();
        options.toplevel = true;
        return new OnOption(options);
    }
    
    S.on = function on(/* args */) {
        return OnOption.prototype.on.apply(new OnOption(new Options()), arguments);
    }
    
    S.async = function async(fn) { 
        return new AsyncOption(new Options()).async(fn); 
    };

    function gate(scheduler : (go : () => void) => void | (() => void)) {
        var root      = new DataNode(null),
            scheduled = false,
            gotime    = 0,
            tick      : any;

        root.emitter = new Emitter(null);

        return function gate(node : ComputationNode<any>) : boolean {
            if (gotime === Time) return true;
            if (typeof tick === 'function') tick();
            else if (!scheduled) {
                scheduled = true;
                tick = scheduler(go);
            }
            addEdge(root.emitter, node);
            return false;
        }
        
        function go() {
            if (gotime === Time) return;
            scheduled = false;
            gotime = Time + 1;
            if (Batching) {
                Batch[Batching++] = root;
            } else {
                handleEvent(root);
            }
        }
    };

    S.event = function event<T>(fn : () => T) : T {
        var result : T;
        
        if (Batching) {
            result = fn();
        } else {
            Batching = 1;

            try {
                result = fn();
                handleEvent(null);
            } finally {
                Batching = 0;
            }
        }
            
        return result;
    };

    S.dispose = function dispose(signal : () => {}) {
        if (Disposing) {
            signal();
        } else {
            Disposing = true;
            try {
                signal();
            } finally {
                Disposing = false;
            }
        }
    }
    
    S.cleanup = function cleanup(fn : () => void) : void {
        if (Updating) {
            (Updating.cleanups || (Updating.cleanups = [])).push(fn);
        } else {
            throw new Error("S.cleanup() must be called from within an S() computation.  Cannot call it at toplevel.");
        }
    };
    
    function handleEvent(change : DataNode<any>) {
        try {
            resolve(change);
        } finally {
            Batching  = 0;
            Updating  = null;
            Disposing = false;
        }
    }
        
    var _batch = [] as DataNode<any>[];
        
    function resolve(change : DataNode<any>) {
        var count = 0, 
            batch : DataNode<any>[], 
            i     : number, 
            len   : number;
            
        if (!Batching) Batching = 1;
            
        if (change) {
            Time++;
            
            prepare(change.emitter);
            
            notify(change.emitter);
            
            i = -1, len = Disposes.length;
            if (len) {
                while (++i < len) Disposes[i].dispose();
                Disposes = [];
            }
        }
        
        // for each frame ...
        while (Batching !== 1) {
            // prepare next frame
            Time++;
            batch = Batch, Batch = _batch, _batch = batch;
            len = Batching, Batching = 1;
            
            // ... set nodes' values, clear pending data, and mark them
            i = 0;
            while (++i < len) {
                change = batch[i];
                change.value = change.pending;
                change.pending = undefined;
                if (change.emitter) prepare(change.emitter);
            }
            
            // run all updates in frame
            i = 0;
            while (++i < len) {
                change = batch[i];
                if (change.emitter) notify(change.emitter);
                batch[i] = null;
            }
            
            i = -1, len = Disposes.length;
            if (len) {
                while (++i < len) Disposes[i].dispose();
                Disposes = [];
            }
            
            if (count++ > 1e5) {
                throw new Error("Runaway frames detected");
            }
        }
    }

    /// mark the node and all downstream nodes as within the range to be updated
    function prepare(emitter : Emitter) {
        var edges     = emitter.edges, 
            i         = -1, 
            len       = edges.length, 
            edge      : Edge, 
            to        : Receiver,
            toEmitter : Emitter;
        
        emitter.emitting = true;
            
        while (++i < len) {
            edge = edges[i];
            if (edge && (!edge.boundary || edge.to.node.gate(edge.to.node))) {
                to = edge.to;
                toEmitter = to.node.emitter;

                // if an earlier update threw an exception, marks may be dirty - clear it now
                if (to.marks !== 0 && to.age < Time) {
                    to.marks = 0;
                    if (toEmitter) {
                        toEmitter.emitting = false;
                    }
                }

                if (toEmitter && toEmitter.emitting)
                    throw new Error("circular dependency"); // TODO: more helpful reporting

                edge.marked = true;
                to.marks++;
                to.age = Time;

                // if this is the first time to's been marked, then propagate
                if (toEmitter && to.marks === 1) {
                    prepare(toEmitter);
                }
            }
        }

        emitter.emitting = false;
    }
    
    function notify(emitter : Emitter) {
        var i    = -1, 
            len  = emitter.edges.length, 
            edge : Edge, 
            to   : Receiver;
            
        while (++i < len) {
            edge = emitter.edges[i];
            if (edge && edge.marked) { // due to gating and backtracking, not all outbound edges may be marked
                to = edge.to;

                edge.marked = false;
                to.marks--;

                if (to.marks === 0) {
                    update(to.node);
                }
            }
        }
                    
        if (len > 10 && len / emitter.active > 4) 
            emitter.compact();
    }
    
    /// update the given node by re-executing any payload, updating inbound links, then updating all downstream nodes
    function update(node : ComputationNode<any>) {
        var emitter  = node.emitter,
            receiver = node.receiver,
            i        : number, 
            len      : number, 
            edge     : Edge, 
            to       : Receiver;
        
        if (node.cleanups) {
            i = -1, len = node.cleanups.length;
            while (++i < len) {
                node.cleanups[i](false);
            }
            node.cleanups = null;
        }
            
        if (node.children) {
            i = -1, len = node.children.length;
            while (++i < len) {
                node.children[i].dispose();
            }
            node.children = null;
        }
        
        Updating = node;

        if (node.fn) node.value = node.fn();

        if (emitter) {
            // this is the content of notify(emitter), inserted to shorten call stack for ergonomics
            i = -1, len = emitter.edges.length;
            while (++i < len) {
                edge = emitter.edges[i];
                if (edge && edge.marked) { // due to gating and backtracking, not all outbound edges may be marked
                    to = edge.to;
    
                    edge.marked = false;
                    to.marks--;
    
                    if (to.marks === 0) {
                        update(to.node);
                    }
                }
            }
                        
            if (len > 10 && len / emitter.active > 4) 
                emitter.compact();
        }
        
        if (receiver && !node.static) {
            i = -1, len = receiver.edges.length;
            while (++i < len) {
                edge = receiver.edges[i];
                if (edge.active && edge.age < Time) {
                    deactivate(edge);
                }
            }
            
            if (len > 10 && len / receiver.active > 4)
                receiver.compact();
        }
    }
        
    /// update the given node by backtracking its dependencies to clean state and updating from there
    function backtrack(receiver : Receiver) {
        var updating = Updating;
        backtrack(receiver);
        Updating = updating;
        
        function backtrack(receiver : Receiver) {
            var i       = -1, 
                len     = receiver.edges.length, 
                edge    : Edge;
                
            while (++i < len) {
                edge = receiver.edges[i];
                if (edge && edge.marked) {
                    if (edge.from.node && edge.from.node.receiver.marks) {
                        // keep working backwards through the marked nodes ...
                        backtrack(edge.from.node.receiver);
                    } else {
                        // ... until we find clean state, from which to start updating
                        notify(edge.from);
                    }
                }
            }
        }
    }
    
    /// Graph classes and operations
    class DataNode<T> {
        age     = 0; // Data nodes start at a time prior to the present, or else they can't be set in the current frame
        pending : T;   
        emitter = null as Emitter;
        
        constructor(
            public value : T
        ) { }
    }
    
    class ComputationNode<T> {
        value     : T;
        static    = false;
        
        emitter   = null as Emitter;
        receiver  = null as Receiver;
        
        children  = null as ComputationNode<any>[];
        cleanups  = null as ((final : boolean) => void)[];
        
        constructor(
            public fn   : () => T, 
            public gate : (node : ComputationNode<any>) => boolean
        )  { }
        
        dispose() {
            if (!this.fn) return;
            
            var i    : number, 
                len  : number, 
                edge : Edge;
                
            if (Updating === this) Updating = null;
            
            this.fn    = null;
            this.gate  = null;
    
            if (this.cleanups) {
                i = -1, len = this.cleanups.length;
                while (++i < len) {
                    this.cleanups[i](true);
                }
                this.cleanups = null;
            }
            
            if (this.receiver) {
                i = -1, len = this.receiver.edges.length;
                while (++i < len) {
                    deactivate(this.receiver.edges[i]);
                }
            }
            
            if (this.emitter) {
                i = -1, len = this.emitter.edges.length;
                while (++i < len) {
                    edge = this.emitter.edges[i];
                    if (edge) deactivate(edge);
                }
            }
            
            if (this.children) {
                i = -1, len = this.children.length;
                while (++i < len) {
                    this.children[i].dispose();
                }
            }
        }
    }
    
    class Emitter {
        static count = 0;
        
        id       = Emitter.count++;
        emitting = false;
        edges    = [] as Edge[];
        index    = [] as Edge[];
        active   = 0;
        edgesAge = 0;
        
        constructor(
            public node : ComputationNode<any>
        ) { }
    
        compact() {
            var i          = -1, 
                len        = this.edges.length, 
                edges      = [] as Edge[], 
                compaction = ++this.edgesAge, 
                edge       : Edge;
                
            while (++i < len) {
                edge = this.edges[i];
                if (edge) {
                    edge.slot = edges.length;
                    edge.slotAge = compaction;
                    edges.push(edge);
                }
            }
            
            this.edges = edges;
        }
    }
    
    function addEdge(from : Emitter, to : ComputationNode<any>) {
        var edge : Edge = null;
        
        if (!to.receiver) to.receiver = new Receiver(to);
        else edge = to.receiver.index[from.id];
        
        if (edge) activate(edge, from);
        else new Edge(from, to.receiver, to.gate && (from.node === null || to.gate !== from.node.gate));
    }
        
    class Receiver {
        static count = 0;
        
        id     = Emitter.count++;
        marks  = 0;
        age    = Time;
        edges  = [] as Edge[];
        index  = [] as Edge[];
        active = 0;
        
        constructor(
            public node : ComputationNode<any>
        ) { }
        
        compact() {
            var i     = -1, 
                len   = this.edges.length, 
                edges = [] as Edge[], 
                index = [] as Edge[], 
                edge  : Edge;
                
            while (++i < len) {
                edge = this.edges[i];
                if (edge.active) {
                    edges.push(edge);
                    index[edge.from.id] = edge;
                }
            }
            
            this.edges = edges;
            this.index = index;
        }
    }

    class Edge {
        age      = Time;
        
        active   = true;
        marked   = false;
        
        slot     : number;
        slotAge  : number;
        
        constructor(
            public from : Emitter, 
            public to : Receiver, 
            public boundary : boolean
        ) {
            this.slot = from.edges.length;
            this.slotAge = from.edgesAge;
    
            from.edges.push(this);
            to.edges.push(this);
            to.index[from.id] = this;
            from.active++;
            to.active++;
        }
    }
        
    function activate(edge : Edge, from : Emitter) {
        if (!edge.active) {
            edge.active = true;
            if (edge.slotAge === from.edgesAge) {
                from.edges[edge.slot] = edge;
            } else {
                edge.slotAge = from.edgesAge;
                edge.slot = from.edges.length;
                from.edges.push(edge);
            }
            edge.to.active++;
            from.active++;
            edge.from = from;
        }
        edge.age = Time;
    }
    
    function deactivate(edge : Edge) {
        if (!edge.active) return;
        var from = edge.from, to = edge.to;
        edge.active = false;
        from.edges[edge.slot] = null;
        from.active--;
        to.active--;
        edge.from = null;
    }
        
    // UMD exporter
    /* globals define */
    if (typeof module === 'object' && typeof module.exports === 'object') {
        module.exports = S; // CommonJS
    } else if (typeof define === 'function') {
        define([], function () { return S; }); // AMD
    } else {
        (eval || function () {})("this").S = S; // fallback to global object
    }
})();