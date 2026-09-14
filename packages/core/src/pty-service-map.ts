import { Layer, LayerMap } from "effect"
import { Location } from "./location"
import { Project } from "./project"
import { EventV2 } from "./event"
import { Pty } from "./pty"

export class PtyServiceMap extends LayerMap.Service<PtyServiceMap>()("@opencode/PtyServiceMap", {
  lookup: (ref: Location.Ref) => {
    const location = Location.layer(ref)
    return Pty.locationLayer.pipe(Layer.provide(location), Layer.fresh)
  },
  idleTimeToLive: "60 minutes",
  dependencies: [Project.defaultLayer, EventV2.defaultLayer],
}) {}
