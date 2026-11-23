import * as T from "three";
import { radiusScale } from "/installation-display.js";

// Work from the original metric mesh every time. Ray picking and the fallback
// renderer both see the very same transformed vertices as the WebGL renderer.
export function installationLens(root, lens) {
  const origin = new T.Vector3(...lens.center);
  const v = new T.Vector3(),
    inverse = new T.Matrix4(),
    sphere = new T.Sphere();
  const geometries = [];
  function project(point) {
    const r = point.distanceTo(origin);
    return point.sub(origin).multiplyScalar(radiusScale(r, lens)).add(origin);
  }
  root.updateMatrixWorld(true);
  root.traverse((mesh) => {
    if (!mesh.isMesh) return;
    const physical = mesh.geometry;
    if (!physical.boundingSphere) physical.computeBoundingSphere();
    sphere.copy(physical.boundingSphere).applyMatrix4(mesh.matrixWorld);
    if (sphere.center.distanceTo(origin) - sphere.radius >= lens.outer) return;
    const overview = physical.clone(),
      positions = overview.attributes.position;
    inverse.copy(mesh.matrixWorld).invert();
    for (let i = 0; i < positions.count; i++) {
      v.fromBufferAttribute(physical.attributes.position, i).applyMatrix4(
        mesh.matrixWorld,
      );
      project(v).applyMatrix4(inverse);
      positions.setXYZ(i, v.x, v.y, v.z);
    }
    overview.computeVertexNormals();
    overview.computeBoundingSphere();
    overview.computeBoundingBox();
    geometries.push({ mesh, physical, overview });
  });
  return {
    project,
    apply(enlarged) {
      for (const g of geometries)
        g.mesh.geometry = enlarged ? g.overview : g.physical;
    },
    dispose() {
      for (const g of geometries) g.overview.dispose();
    },
  };
}
