declare module "chrome-remote-interface" {
    interface CDPClient {
      Page: {
        enable(): Promise<void>;
        reload(params?: { ignoreCache?: boolean }): Promise<void>;
        loadEventFired(callback: () => void): void;
      };
      Debugger: {
        enable(): Promise<void>;
        disable(): Promise<void>;
        setBreakpointByUrl(params: {
          lineNumber: number;
          urlRegex?: string;
          url?: string;
          columnNumber?: number;
          condition?: string;
        }): Promise<{
          breakpointId: string;
          locations: Array<{
            scriptId: string;
            lineNumber: number;
            columnNumber: number;
          }>;
        }>;
        removeBreakpoint(params: { breakpointId: string }): Promise<void>;
        resume(params?: { terminateOnResume?: boolean }): Promise<void>;
        stepInto(params?: object): Promise<void>;
        stepOver(params?: object): Promise<void>;
        stepOut(params?: object): Promise<void>;
        pause(): Promise<void>;
        evaluateOnCallFrame(params: {
          callFrameId: string;
          expression: string;
          objectGroup?: string;
          includeCommandLineAPI?: boolean;
          silent?: boolean;
          returnByValue?: boolean;
          generatePreview?: boolean;
          throwOnSideEffect?: boolean;
        }): Promise<{
          result: RuntimeRemoteObject;
          exceptionDetails?: ExceptionDetails;
        }>;
        paused(callback: (params: DebuggerPausedEvent) => void): void;
        resumed(callback: () => void): void;
      };
      Runtime: {
        enable(): Promise<void>;
        getProperties(params: {
          objectId: string;
          ownProperties?: boolean;
          accessorPropertiesOnly?: boolean;
          generatePreview?: boolean;
          nonIndexedPropertiesOnly?: boolean;
        }): Promise<{
          result: PropertyDescriptor[];
          internalProperties?: InternalPropertyDescriptor[];
          exceptionDetails?: ExceptionDetails;
        }>;
      };
      on(event: string, callback: (...args: any[]) => void): void;
      close(): Promise<void>;
    }
  
    interface DebuggerPausedEvent {
      callFrames: CallFrame[];
      reason: string;
      data?: object;
      hitBreakpoints?: string[];
      asyncStackTrace?: object;
    }
  
    interface CallFrame {
      callFrameId: string;
      functionName: string;
      functionLocation?: {
        scriptId: string;
        lineNumber: number;
        columnNumber: number;
      };
      location: {
        scriptId: string;
        lineNumber: number;
        columnNumber: number;
      };
      url: string;
      scopeChain: ScopeDescriptor[];
      this: RuntimeRemoteObject;
      returnValue?: RuntimeRemoteObject;
    }
  
    interface ScopeDescriptor {
      type:
        | "global"
        | "local"
        | "with"
        | "closure"
        | "catch"
        | "block"
        | "script"
        | "eval"
        | "module";
      object: RuntimeRemoteObject;
      name?: string;
      startLocation?: {
        scriptId: string;
        lineNumber: number;
        columnNumber: number;
      };
      endLocation?: {
        scriptId: string;
        lineNumber: number;
        columnNumber: number;
      };
    }
  
    interface RuntimeRemoteObject {
      type: string;
      subtype?: string;
      className?: string;
      value?: any;
      unserializableValue?: string;
      description?: string;
      objectId?: string;
      preview?: ObjectPreview;
    }
  
    interface ObjectPreview {
      type: string;
      subtype?: string;
      description?: string;
      overflow: boolean;
      properties: PropertyPreview[];
    }
  
    interface PropertyPreview {
      name: string;
      type: string;
      value?: string;
      valuePreview?: ObjectPreview;
      subtype?: string;
    }
  
    interface PropertyDescriptor {
      name: string;
      value?: RuntimeRemoteObject;
      writable?: boolean;
      get?: RuntimeRemoteObject;
      set?: RuntimeRemoteObject;
      configurable: boolean;
      enumerable: boolean;
      wasThrown?: boolean;
      isOwn?: boolean;
      symbol?: RuntimeRemoteObject;
    }
  
    interface InternalPropertyDescriptor {
      name: string;
      value?: RuntimeRemoteObject;
    }
  
    interface ExceptionDetails {
      exceptionId: number;
      text: string;
      lineNumber: number;
      columnNumber: number;
      scriptId?: string;
      url?: string;
      stackTrace?: object;
      exception?: RuntimeRemoteObject;
      executionContextId?: number;
    }
  
    interface CDPOptions {
      host?: string;
      port?: number;
      secure?: boolean;
      target?: string | ((targets: ChromeTarget[]) => ChromeTarget);
    }
  
    interface ChromeTarget {
      id: string;
      title: string;
      url: string;
      type: string;
      webSocketDebuggerUrl?: string;
      devtoolsFrontendUrl?: string;
    }
  
    interface ListOptions {
      host?: string;
      port?: number;
    }
  
    function CDP(options?: CDPOptions): Promise<CDPClient>;
    namespace CDP {
      function List(options?: ListOptions): Promise<ChromeTarget[]>;
    }
  
    export default CDP;
    export type {
      CDPClient,
      CallFrame,
      ScopeDescriptor,
      RuntimeRemoteObject,
      PropertyDescriptor,
      ExceptionDetails,
      DebuggerPausedEvent,
      ChromeTarget,
    };
  }