import { Fn, vec3, float, normalize } from 'three/tsl';

// 3D Curl Noise using finite differences
export const curlNoise3D = Fn( ( [ p, baseNoise ] ) => {

    const eps = float( 0.001 );
    const eps2 = eps.mul( 2.0 );
    
    // Sample base noise around the point
    const x1 = baseNoise( p.add( vec3( eps, 0, 0 ) ) );
    const x0 = baseNoise( p.sub( vec3( eps, 0, 0 ) ) );
    
    const y1 = baseNoise( p.add( vec3( 0, eps, 0 ) ) );
    const y0 = baseNoise( p.sub( vec3( 0, eps, 0 ) ) );
    
    const z1 = baseNoise( p.add( vec3( 0, 0, eps ) ) );
    const z0 = baseNoise( p.sub( vec3( 0, 0, eps ) ) );
    
    // Compute cross derivatives for Curl
    // curl.x = dNz/dy - dNy/dz
    const x = y1.z.sub( y0.z ).sub( z1.y.sub( z0.y ) );
    
    // curl.y = dNx/dz - dNz/dx
    const y = z1.x.sub( z0.x ).sub( x1.z.sub( x0.z ) );
    
    // curl.z = dNy/dx - dNx/dy
    const z = x1.y.sub( x0.y ).sub( y1.x.sub( y0.x ) );
    
    return normalize( vec3( x, y, z ).div( eps2 ) );

} );