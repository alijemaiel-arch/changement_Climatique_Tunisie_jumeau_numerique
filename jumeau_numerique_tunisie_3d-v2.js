/**
 * ===============================================================================
 * JUMEAU NUMÉRIQUE 3D WEBGL (v2) - SIMULATION DE L'ÉROSION CÔTIÈRE & 
 * MARQUEURS INTERACTIFS D'INFRASTRUCTURES CRITIQUES EN TUNISIE
 * ===============================================================================
 * Nouveautés v2 :
 * 1. Marqueurs 3D interactifs pour les infrastructures côtières stratégiques
 *    (ex: STEP Houmt Essouk - Djerba, STEP Radès, Port de La Goulette, Route littorale, Carthage).
 * 2. Moteur de détection de franchissement de seuil critique d'inondation.
 * 3. Balises 3D avec animation visuelle (Vert = Normal, Orange = Alerte, Rouge = Submergé/Saturé).
 * 4. Raycasting interactif (clic/survol pour afficher la fiche de vulnérabilité).
 * ===============================================================================
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

// ===============================================================================
// 1. SHADER GLSL PERSONNALISÉ POUR LA HOULE ET LES TEMPÊTES
// ===============================================================================

const waveVertexShader = `
uniform float uTime;
uniform float uStormIntensity; // 0.0 = mer calme, 1.0 = tempête extrême
uniform vec2 uFrequency;
varying float vElevation;

void main() {
    vec4 modelPosition = modelMatrix * vec4(position, 1.0);

    // Ondulation de base (combinaison harmonique sinus / cosinus)
    float elevation = sin(modelPosition.x * uFrequency.x + uTime * 2.0) * 
                      cos(modelPosition.z * uFrequency.y + uTime * 1.5) * 0.5;

    // Amplification dynamique selon l'intensité de la tempête
    elevation += sin(modelPosition.x * 0.05 + uTime * 4.0) * 
                 sin(modelPosition.z * 0.05 + uTime * 3.0) * (2.0 * uStormIntensity);

    modelPosition.y += elevation;
    vElevation = elevation;

    vec4 viewPosition = viewMatrix * modelPosition;
    vec4 projectedPosition = projectionMatrix * viewPosition;

    gl_Position = projectedPosition;
}
`;

const waveFragmentShader = `
uniform vec3 uDepthColor;
uniform vec3 uSurfaceColor;
uniform vec3 uFoamColor;
varying float vElevation;

void main() {
    // Fondu de couleur entre les creux et les crêtes
    float mixStrength = (vElevation + 2.0) / 5.0;
    vec3 color = mix(uDepthColor, uSurfaceColor, mixStrength);

    // Génération d'écume sur les crêtes des vagues lors des tempêtes
    if (vElevation > 1.2) {
        color = mix(color, uFoamColor, (vElevation - 1.2) * 0.7);
    }

    gl_FragColor = vec4(color, 0.85); // Transparence aquatique
}
`;

export function createCustomSeaMaterial() {
    return new THREE.ShaderMaterial({
        vertexShader: waveVertexShader,
        fragmentShader: waveFragmentShader,
        transparent: true,
        uniforms: {
            uTime: { value: 0 },
            uStormIntensity: { value: 0.2 },
            uFrequency: { value: new THREE.Vector2(0.02, 0.02) },
            uDepthColor: { value: new THREE.Color(0x001e3f) },   // Bleu profond
            uSurfaceColor: { value: new THREE.Color(0x00a8ff) }, // Turquoise de surface
            uFoamColor: { value: new THREE.Color(0xffffff) }     // Écume blanche
        }
    });
}

// ===============================================================================
// 2. DONNÉES ET MARQUEURS 3D D'INFRASTRUCTURES CÔTIÈRES
// ===============================================================================

export const COASTAL_INFRASTRUCTURES = [
    {
        id: 'step_houmt_essouk',
        name: 'STEP Houmt Essouk (Djerba)',
        type: 'Assainissement / STEP',
        position: { x: 120, y: 3.5, z: 80 },
        criticalThresholdMeters: 0.25, // Seuil d'inondation critique en mètres
        baseSaturationRate: '115%',
        odd: 'ODD 6 & ODD 11',
        description: 'Station d\'épuration opérant déjà à 115% de sa capacité. Haut risque de débordement lors des surcotes marines.'
    },
    {
        id: 'step_rades',
        name: 'STEP Grand Tunis (Radès / Meliane)',
        type: 'Assainissement / STEP',
        position: { x: -40, y: 4.2, z: -150 },
        criticalThresholdMeters: 0.40,
        baseSaturationRate: '98%',
        odd: 'ODD 6 & ODD 14',
        description: 'Infrastructure clé de traitement des eaux usées du Golfe de Tunis. Menacée par la salinisation et la submersion.'
    },
    {
        id: 'port_goulette',
        name: 'Port de Commerce de La Goulette',
        type: 'Transport / Logistique',
        position: { x: -20, y: 5.0, z: -180 },
        criticalThresholdMeters: 0.50,
        baseSaturationRate: '85%',
        odd: 'ODD 9 & ODD 11',
        description: 'Hub portuaire stratégique. Risque de paralysie des flux logistiques en cas de hausse du niveau de la mer > 0.5m.'
    },
    {
        id: 'route_djerba',
        name: 'Route Littorale Djerba - Ajim',
        type: 'Transport / Axe Routier',
        position: { x: 180, y: 2.0, z: 120 },
        criticalThresholdMeters: 0.18,
        baseSaturationRate: '100%',
        odd: 'ODD 9 & ODD 13',
        description: 'Axe routier insulaire critique situé à très faible altitude (<2m). Rupture fréquente lors des vagues de submersion.'
    },
    {
        id: 'patrimoine_carthage',
        name: 'Site Archéologique Littoral de Carthage',
        type: 'Patrimoine / Culture',
        position: { x: -60, y: 6.0, z: -210 },
        criticalThresholdMeters: 0.60,
        baseSaturationRate: 'Vulnérable',
        odd: 'ODD 11 & ODD 15',
        description: 'Vestiges puniques et romains côtiers exposés à l\'érosion marine accélérée et aux projections de sel.'
    }
];

// ===============================================================================
// 3. CHARGEUR DE RELIEF RÉEL GEOJSON (GOLFE DE TUNIS / DJERBA)
// ===============================================================================

export async function loadGeoJSONTerrain(scene, geojsonUrl, centerLon = 10.8, centerLat = 33.8) {
    try {
        const response = await fetch(geojsonUrl);
        const geojsonData = await response.json();

        const terrainGroup = new THREE.Group();
        const scaleFactor = 10000;

        geojsonData.features.forEach(feature => {
            const geometryType = feature.geometry.type;

            if (geometryType === 'Polygon' || geometryType === 'MultiPolygon') {
                const polygonList = geometryType === 'Polygon' ? [feature.geometry.coordinates] : feature.geometry.coordinates;

                polygonList.forEach(poly => {
                    const shape = new THREE.Shape();
                    const outerRing = poly[0];

                    outerRing.forEach((coord, index) => {
                        const x = (coord[0] - centerLon) * scaleFactor;
                        const y = (coord[1] - centerLat) * scaleFactor;

                        if (index === 0) shape.moveTo(x, y);
                        else shape.lineTo(x, y);
                    });

                    const elevation = feature.properties.elevation || feature.properties.altitude || 1.0;

                    const extrudeSettings = {
                        steps: 1,
                        depth: Math.max(0.5, elevation * 1.5),
                        bevelEnabled: false
                    };

                    const geom = new THREE.ExtrudeGeometry(shape, extrudeSettings);
                    geom.rotateX(-Math.PI / 2);

                    const mat = new THREE.MeshStandardMaterial({
                        color: elevation < 3.0 ? 0xd2b48c : 0x2e8b57,
                        roughness: 0.85
                    });

                    const mesh = new THREE.Mesh(geom, mat);
                    terrainGroup.add(mesh);
                });
            }
        });

        scene.add(terrainGroup);
        return terrainGroup;
    } catch (err) {
        console.warn('GeoJSON non disponible, génération du terrain 3D de secours:', err);
        return createFallbackTerrain(scene);
    }
}

function createFallbackTerrain(scene) {
    const width = 1200, height = 1200, segments = 128;
    const terrainGeo = new THREE.PlaneGeometry(width, height, segments, segments);
    terrainGeo.rotateX(-Math.PI / 2);

    const pos = terrainGeo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
        let x = pos.getX(i);
        let z = pos.getZ(i);
        let elevation = Math.max(0, (x + 300) * 0.08) + Math.sin(x * 0.02) * Math.cos(z * 0.02) * 4;
        pos.setY(i, elevation);
    }
    terrainGeo.computeVertexNormals();

    const terrainMat = new THREE.MeshStandardMaterial({ color: 0xc2b280, roughness: 0.9 });
    const mesh = new THREE.Mesh(terrainGeo, terrainMat);
    scene.add(mesh);
    return mesh;
}

// ===============================================================================
// 4. MOTEUR DU JUMEAU NUMÉRIQUE 3D ET GESTIONNAIRE D'INFRASTRUCTURES
// ===============================================================================

export class TunisiaDigitalTwin {
    constructor(containerId = 'app-container') {
        this.container = document.getElementById(containerId) || document.body;
        this.clock = new THREE.Clock();
        this.markers = [];
        this.currentSeaLevelMeters = 0.0;
        this.currentStormIntensity = 0.1;

        this.initScene();
        this.initLights();
        this.initWater();
        this.initInfrastructureMarkers();
        this.initControls();
        this.initRaycaster();
        this.bindEvents();

        this.animate = this.animate.bind(this);
        requestAnimationFrame(this.animate);
    }

    initScene() {
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x87ceeb);

        this.camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 5000);
        this.camera.position.set(0, 250, 450);

        this.renderer = new THREE.WebGLRenderer({ antialias: true });
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        this.container.appendChild(this.renderer.domElement);
    }

    initLights() {
        const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
        this.scene.add(ambientLight);

        const sunLight = new THREE.DirectionalLight(0xffffff, 0.9);
        sunLight.position.set(200, 400, 150);
        this.scene.add(sunLight);
    }

    initWater() {
        this.seaMaterial = createCustomSeaMaterial();
        const seaGeometry = new THREE.PlaneGeometry(1500, 1500, 128, 128);
        seaGeometry.rotateX(-Math.PI / 2);

        this.seaMesh = new THREE.Mesh(seaGeometry, this.seaMaterial);
        this.seaMesh.position.y = 0;
        this.scene.add(this.seaMesh);
    }

    initInfrastructureMarkers() {
        const markerGroup = new THREE.Group();

        COASTAL_INFRASTRUCTURES.forEach(data => {
            // Création du pin 3D (pylône + sphère pulsante)
            const pinGroup = new THREE.Group();
            pinGroup.position.set(data.position.x, data.position.y, data.position.z);

            // Mât
            const stemGeo = new THREE.CylinderGeometry(0.8, 0.8, 25, 16);
            stemGeo.translate(0, 12.5, 0);
            const stemMat = new THREE.MeshStandardMaterial({ color: 0x444444, metalness: 0.5 });
            const stemMesh = new THREE.Mesh(stemGeo, stemMat);
            pinGroup.add(stemMesh);

            // Tête de balise (Sphère d'alerte)
            const headGeo = new THREE.SphereGeometry(6, 32, 32);
            headGeo.translate(0, 25, 0);
            const headMat = new THREE.MeshStandardMaterial({
                color: 0x00ff00, // Vert par défaut (Normal)
                emissive: 0x003300,
                roughness: 0.3
            });
            const headMesh = new THREE.Mesh(headGeo, headMat);
            headMesh.userData = { ...data, isMarkerHead: true };
            pinGroup.add(headMesh);

            // Anneau d'onde de choc 3D
            const ringGeo = new THREE.RingGeometry(8, 11, 32);
            ringGeo.rotateX(-Math.PI / 2);
            const ringMat = new THREE.MeshBasicMaterial({
                color: 0x00ff00,
                side: THREE.DoubleSide,
                transparent: true,
                opacity: 0.6
            });
            const ringMesh = new THREE.Mesh(ringGeo, ringMat);
            ringMesh.position.y = 0.5;
            pinGroup.add(ringMesh);

            markerGroup.add(pinGroup);

            this.markers.push({
                data,
                pinGroup,
                headMesh,
                headMat,
                ringMesh,
                ringMat
            });
        });

        this.scene.add(markerGroup);
    }

    initControls() {
        this.controls = new OrbitControls(this.camera, this.renderer.domElement);
        this.controls.enableDamping = true;
        this.controls.dampingFactor = 0.05;
    }

    initRaycaster() {
        this.raycaster = new THREE.Raycaster();
        this.mouse = new THREE.Vector2();

        window.addEventListener('click', (e) => {
            this.mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
            this.mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;

            this.raycaster.setFromCamera(this.mouse, this.camera);
            const headMeshes = this.markers.map(m => m.headMesh);
            const intersects = this.raycaster.intersectObjects(headMeshes);

            if (intersects.length > 0) {
                const clickedData = intersects[0].object.userData;
                this.onMarkerClick(clickedData);
            }
        });
    }

    onMarkerClick(data) {
        const isFlooded = this.currentSeaLevelMeters >= data.criticalThresholdMeters;
        
        console.log(`[INFRASTRUCTURE SELECTED] ${data.name}`);
        
        // Dispatch événement personnalisé pour l'interface UI
        const event = new CustomEvent('infrastructureSelected', {
            detail: { ...data, isFlooded, currentSeaLevel: this.currentSeaLevelMeters }
        });
        window.dispatchEvent(event);
    }

    getSeaLevelForYear(year) {
        if (year <= 2020) return 0.0;
        if (year <= 2050) return ((year - 2020) / 30) * 0.23;
        return 0.23 + ((year - 2050) / 50) * (0.68 - 0.23);
    }

    setYear(year) {
        this.currentSeaLevelMeters = this.getSeaLevelForYear(year);
        // Amplification visuelle 3D (x15)
        this.seaMesh.position.y = this.currentSeaLevelMeters * 15;

        this.updateMarkerStatuses();

        const shorelineRetreatMeters = (this.currentSeaLevelMeters * 100).toFixed(1);

        return {
            year,
            seaLevelMeters: this.currentSeaLevelMeters.toFixed(2),
            shorelineRetreatMeters
        };
    }

    setStormIntensity(intensity) {
        this.currentStormIntensity = intensity;
        this.seaMaterial.uniforms.uStormIntensity.value = intensity;
        this.updateMarkerStatuses();
    }

    updateMarkerStatuses() {
        const stormSurgeAdd = this.currentStormIntensity * 0.35; // Surcote météo
        const effectiveWaterLevel = this.currentSeaLevelMeters + stormSurgeAdd;

        this.markers.forEach(m => {
            const threshold = m.data.criticalThresholdMeters;

            if (effectiveWaterLevel >= threshold) {
                // ROUGE : Submergé / Alerte critique
                m.headMat.color.setHex(0xff0000);
                m.headMat.emissive.setHex(0x660000);
                m.ringMat.color.setHex(0xff0000);
            } else if (effectiveWaterLevel >= threshold - 0.1) {
                // ORANGE : Attention / Proche du seuil
                m.headMat.color.setHex(0xffa500);
                m.headMat.emissive.setHex(0x553300);
                m.ringMat.color.setHex(0xffa500);
            } else {
                // VERT : Normal
                m.headMat.color.setHex(0x00ff00);
                m.headMat.emissive.setHex(0x003300);
                m.ringMat.color.setHex(0x00ff00);
            }
        });
    }

    bindEvents() {
        window.addEventListener('resize', () => {
            this.camera.aspect = window.innerWidth / window.innerHeight;
            this.camera.updateProjectionMatrix();
            this.renderer.setSize(window.innerWidth, window.innerHeight);
        });
    }

    animate() {
        requestAnimationFrame(this.animate);

        const elapsedTime = this.clock.getElapsedTime();
        this.seaMaterial.uniforms.uTime.value = elapsedTime;

        // Pulsation dynamique des balises
        this.markers.forEach((m, idx) => {
            const scale = 1 + Math.sin(elapsedTime * 4 + idx) * 0.15;
            m.ringMesh.scale.set(scale, scale, scale);
        });

        this.controls.update();
        this.renderer.render(this.scene, this.camera);
    }
}

if (typeof window !== 'undefined') {
    window.TunisiaDigitalTwin = TunisiaDigitalTwin;
    window.loadGeoJSONTerrain = loadGeoJSONTerrain;
    window.COASTAL_INFRASTRUCTURES = COASTAL_INFRASTRUCTURES;
}
