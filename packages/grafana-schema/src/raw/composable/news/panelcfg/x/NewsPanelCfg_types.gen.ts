// Code generated - EDITING IS FUTILE. DO NOT EDIT.
//
// Generated by:
//     public/app/plugins/gen.go
// Using jennies:
//     TSTypesJenny
//     LatestMajorsOrXJenny
//     PluginEachMajorJenny
//
// Run 'make gen-cue' from repository root to regenerate.

export const pluginVersion = "10.2.6";

export interface Options {
  /**
   * empty/missing will default to grafana blog
   */
  feedUrl?: string;
  showImage?: boolean;
}

export const defaultOptions: Partial<Options> = {
  showImage: true,
};
