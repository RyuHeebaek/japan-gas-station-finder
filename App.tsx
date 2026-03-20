import React, { useEffect, useState, useRef } from 'react';
import { Image, Animated } from 'react-native';
import LinearGradient from 'react-native-linear-gradient';
import * as Animatable from 'react-native-animatable';
import { useColorScheme } from 'react-native';
import {
    Alert,
    Linking,
    Platform,
    StyleSheet,
    Text,
    TouchableOpacity,
    View,
    FlatList,
    TextInput,
} from 'react-native';
import MapView, { Marker } from 'react-native-maps';
import { request, PERMISSIONS, RESULTS } from 'react-native-permissions';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Geolocation from '@react-native-community/geolocation';
import { gasStations } from './data/gasStations';

// 위치 타입 정의
type GeoPosition = {
    coords: {
        latitude: number;
        longitude: number;
        altitude: number | null;
        accuracy: number;
        altitudeAccuracy: number | null;
        heading: number | null;
        speed: number | null;
    };
    timestamp: number;
};

type GeoError = {
    code: number;
    message: string;
    PERMISSION_DENIED: number;
    POSITION_UNAVAILABLE: number;
    TIMEOUT: number;
};

type StationWithDistance = typeof gasStations[0] & {
  distance: number;
  address?: string;
  brand?: string;
};


const brandColorMap: Record<string, string> = {
  ENEOS: '#f37021',
  Idemitsu: '#d71920',
  default: '#888',
};

const flatListRef = React.useRef<FlatList>(null);

const App = () => {
    const scheme = useColorScheme();
    const isDark = scheme === 'dark';
    const [selectedFuel, setSelectedFuel] = useState<string>('전체');
    const [selectedStation, setSelectedStation] = useState<null | StationWithDistance>(null);
    const [favorites, setFavorites] = useState<string[]>([]);
    const [searchKeyword, setSearchKeyword] = useState<string>('');
    const [sortOrder, setSortOrder] = useState<'asc' | 'desc' | null>(null);
    const [showOnlyFavorites, setShowOnlyFavorites] = useState<boolean>(false);
    const [currentPosition, setCurrentPosition] = useState<{ latitude: number; longitude: number } | null>(null);
    const [followUserLocation, setFollowUserLocation] = useState(true);
    const [recentSearches, setRecentSearches] = useState<string[]>([]);
    const mapRef = useRef<MapView>(null);
    const [panelAnim] = useState(new Animated.Value(0));

    useEffect(() => {
        const requestLocationPermission = async () => {
            const permission = Platform.select({
                ios: PERMISSIONS.IOS.LOCATION_WHEN_IN_USE,
                android: PERMISSIONS.ANDROID.ACCESS_FINE_LOCATION,
            });
            if (!permission) return;
            const result = await request(permission);
            if (result === RESULTS.GRANTED) {
                console.log('✅ 위치 권한 허용됨');
                Geolocation.getCurrentPosition(
                    (position: GeoPosition) => {
                        setCurrentPosition({
                            latitude: position.coords.latitude,
                            longitude: position.coords.longitude,
                        });
                    },
                    (error: GeoError) => {
                        console.warn('위치 가져오기 실패:', error);
                    },
                    { enableHighAccuracy: true, timeout: 15000, maximumAge: 10000 }
                );
            } else {
                Alert.alert('위치 권한 필요', '주변 주유소를 표시하려면 위치 권한이 필요합니다.', [
                    { text: '취소', style: 'cancel' },
                    { text: '설정 열기', onPress: () => Linking.openSettings() },
                ]);
            }
        };
        void requestLocationPermission();
        void loadFavorites();
        void loadRecentSearches();
        void loadPersistedState();
    }, []);

    // Filter and sort stations according to UI state (for rendering)
    // (auto-selection logic moved above, see new useEffect)
    // Load persisted UI state (fuel, sort, favoritesOnly, keyword)
    const loadPersistedState = async () => {
        const fuel = await AsyncStorage.getItem('SELECTED_FUEL');
        const sort = await AsyncStorage.getItem('SORT_ORDER');
        const favoritesOnly = await AsyncStorage.getItem('SHOW_ONLY_FAVORITES');
        const keyword = await AsyncStorage.getItem('SEARCH_KEYWORD');

        if (fuel) setSelectedFuel(fuel);
        if (sort === 'asc' || sort === 'desc') setSortOrder(sort);
        if (favoritesOnly === 'true') setShowOnlyFavorites(true);
        if (keyword) setSearchKeyword(keyword);
    };

    // 10초마다 현재 위치 갱신 (거리 갱신용, 따라가기와 별개)
    useEffect(() => {
        const interval = setInterval(() => {
            Geolocation.getCurrentPosition(
                (position: GeoPosition) => {
                    setCurrentPosition({
                        latitude: position.coords.latitude,
                        longitude: position.coords.longitude,
                    });
                },
                (error: GeoError) => {
                    console.warn('거리 갱신 실패:', error);
                },
                { enableHighAccuracy: true, timeout: 10000, maximumAge: 5000 }
            );
        }, 10000); // 10초 간격

        return () => clearInterval(interval);
    }, []);

    useEffect(() => {
        if (!followUserLocation) return;

        const watchId = Geolocation.watchPosition(
            (position: GeoPosition) => {
                const { latitude, longitude } = position.coords;
                setCurrentPosition({ latitude, longitude });
                if (mapRef.current) {
                    mapRef.current.animateToRegion({
                        latitude,
                        longitude,
                        latitudeDelta: 0.02,
                        longitudeDelta: 0.02,
                    });
                }
            },
            (error: GeoError) => console.error('위치 추적 실패:', error),
            { enableHighAccuracy: true, distanceFilter: 10 }
        );

        return () => Geolocation.clearWatch(watchId);
    }, [followUserLocation]);

    const openGoogleMaps = (latitude: number, longitude: number, name: string) => {
        const url = `https://www.google.com/maps/dir/?api=1&destination=${latitude},${longitude}&destination_place_id=${encodeURIComponent(
            name
        )}&travelmode=driving`;
        Linking.canOpenURL(url)
            .then((supported) => {
                if (supported) {
                    Linking.openURL(url);
                } else {
                    Alert.alert('구글 맵을 열 수 없습니다.');
                }
            })
            .catch((err) => console.error('구글맵 연결 실패:', err));
    };

    const toggleFavorite = async (stationId: string) => {
        const updatedFavorites = favorites.includes(stationId)
            ? favorites.filter((id) => id !== stationId)
            : [...favorites, stationId];
        setFavorites(updatedFavorites);
        await AsyncStorage.setItem('FAVORITES', JSON.stringify(updatedFavorites));
    };

    const loadFavorites = async () => {
        const saved = await AsyncStorage.getItem('FAVORITES');
        if (saved) setFavorites(JSON.parse(saved));
    };

    const loadRecentSearches = async () => {
        const saved = await AsyncStorage.getItem('RECENT_SEARCHES');
        if (saved) setRecentSearches(JSON.parse(saved));
    };

    const saveRecentSearch = async (keyword: string) => {
        if (!keyword.trim()) return;
        const updated = [keyword, ...recentSearches.filter((k) => k !== keyword)].slice(0, 5);
        setRecentSearches(updated);
        await AsyncStorage.setItem('RECENT_SEARCHES', JSON.stringify(updated));
    };

    // Filter and sort stations according to UI state (for rendering)
    const filteredStations = gasStations
        .map(({ id, name, latitude, longitude, fuelType, price }) => {
            const distance = currentPosition
                ? Math.sqrt(
                    Math.pow(currentPosition.latitude - latitude, 2) +
                    Math.pow(currentPosition.longitude - longitude, 2)
                )
                : 0;
            return {
                id,
                name,
                latitude,
                longitude,
                fuelType,
                price,
                distance,
            };
        })
        .filter((station) => selectedFuel === '전체' || station.fuelType === selectedFuel)
        .filter((station) => station.name.includes(searchKeyword))
        .filter((station) => (showOnlyFavorites ? favorites.includes(station.id) : true))
        .sort((a, b) => {
            if (sortOrder === 'asc') return a.price - b.price;
            if (sortOrder === 'desc') return b.price - a.price;
            return a.distance - b.distance;
        });

    // Auto-select nearest station when position or stations change
    useEffect(() => {
        if (!currentPosition || selectedStation || gasStations.length === 0) return;

        const nearest = filteredStations[0];

        if (nearest) {
            setSelectedStation(nearest);
            mapRef.current?.animateToRegion({
                latitude: nearest.latitude,
                longitude: nearest.longitude,
                latitudeDelta: 0.01,
                longitudeDelta: 0.01,
            });
            const index = filteredStations.findIndex((s: StationWithDistance) => s.id === nearest.id);
            if (flatListRef.current && index !== -1) {
                flatListRef.current.scrollToIndex({ index, animated: true });
            }
        }
    }, [currentPosition, selectedStation, selectedFuel, searchKeyword, showOnlyFavorites, sortOrder, favorites]);

    // 상세정보 패널 슬라이드 애니메이션
    useEffect(() => {
        Animated.timing(panelAnim, {
            toValue: selectedStation ? 1 : 0,
            duration: 300,
            useNativeDriver: true,
        }).start();
    }, [selectedStation]);


    return (
        <View style={[styles.container, { backgroundColor: isDark ? '#000' : '#fff' }]}>
            <MapView
                ref={mapRef}
                style={styles.map}
                showsUserLocation={true}
                showsMyLocationButton={true}
                initialRegion={{
                    latitude: 35.6661,
                    longitude: 139.7041,
                    latitudeDelta: 0.05,
                    longitudeDelta: 0.05,
                }}
                onPanDrag={() => {
                    if (followUserLocation) {
                        setFollowUserLocation(false);
                    }
                }}
            >
                {filteredStations.map((station: StationWithDistance) => (
                    <Marker
                        key={station.id}
                        coordinate={{ latitude: station.latitude, longitude: station.longitude }}
                        title={station.name}
                        description={`${station.fuelType}: ¥${station.price}`}
                        onPress={() => {
                            setSelectedStation(station);
                            // Scroll to the matching FlatList item
                            const index = filteredStations.findIndex((s: StationWithDistance) => s.id === station.id);
                            if (flatListRef.current && index !== -1) {
                                flatListRef.current.scrollToIndex({ index, animated: true });
                            }
                        }}
                        image={
                            selectedStation?.id === station.id
                                ? require('./assets/selected-marker.png')
                                : require('./assets/marker.png')
                        }
                    />
                ))}
            </MapView>

            <FlatList
                ref={flatListRef}
                data={filteredStations}
                keyExtractor={(item: StationWithDistance) => item.id}
                style={[styles.stationList, { backgroundColor: isDark ? '#111' : '#fff' }]}
                contentContainerStyle={{ paddingBottom: 30 }}
                extraData={selectedStation}
                renderItem={({ item }: { item: StationWithDistance }) => (
                  <Animatable.View
                    animation={selectedStation?.id === item.id ? 'pulse' : undefined}
                    duration={300}
                  >
                    <TouchableOpacity
                      onPress={() => {
                        setSelectedStation(item);
                        mapRef.current?.animateToRegion({
                          latitude: item.latitude,
                          longitude: item.longitude,
                          latitudeDelta: 0.01,
                          longitudeDelta: 0.01,
                        });
                      }}
                      style={{ marginHorizontal: 12, marginVertical: 6 }}
                    >
                      <LinearGradient
                        colors={
                          selectedStation?.id === item.id
                            ? ['#e0f0ff', '#ffffff']
                            : ['#ffffff', '#f8f8f8']
                        }
                        style={[
                          styles.stationItem,
                          selectedStation?.id === item.id && styles.stationItemSelected,
                        ]}
                      >
                        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                            <View style={{
                              width: 6,
                              height: '100%',
                              backgroundColor: brandColorMap[item.brand ?? 'default'],
                              borderRadius: 2,
                              marginRight: 10,
                            }} />
                            <Image
                              source={
                                item.brand === 'ENEOS'
                                  ? require('./assets/logos/eneos.png')
                                  : item.brand === 'Idemitsu'
                                  ? require('./assets/logos/idemitsu.png')
                                  : require('./assets/logos/default.png')
                              }
                              style={{ width: 20, height: 20, marginRight: 6 }}
                            />
                            <Text style={[styles.stationItemTitle, { color: isDark ? '#fff' : '#000' }]}>{item.name}</Text>
                          </View>
                          <Text style={[styles.stationItemDistance, { color: '#4A90E2' }]}>
                            📍 {(item.distance * 111).toFixed(2)} km
                          </Text>
                        </View>
                        <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 4 }}>
                          <Text style={{ fontSize: 15, fontWeight: '500', color: isDark ? '#fff' : '#000' }}>
                            ⛽ {item.fuelType}
                          </Text>
                          <Text style={{
                            fontWeight: 'bold',
                            fontSize: 16,
                            color: item.price <= 150
                              ? 'green'
                              : item.price >= 170
                                ? 'red'
                                : 'orange'
                          }}>
                            ¥{item.price}
                          </Text>
                        </View>
                        <View style={{
                          flexDirection: 'row',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          marginTop: 12,
                          paddingTop: 8,
                          borderTopWidth: 1,
                          borderTopColor: isDark ? '#333' : '#eee',
                        }}>
                          <TouchableOpacity onPress={() => openGoogleMaps(item.latitude, item.longitude, item.name)}>
                            <Text style={{ color: '#007AFF', fontWeight: 'bold', fontSize: 14 }}>길찾기</Text>
                          </TouchableOpacity>
                          <TouchableOpacity onPress={() => toggleFavorite(item.id)}>
                            <Text style={{ fontSize: 18 }}>
                              {favorites.includes(item.id) ? '⭐' : '☆'}
                            </Text>
                          </TouchableOpacity>
                        </View>
                      </LinearGradient>
                    </TouchableOpacity>
                  </Animatable.View>
                )}
            />

            <View style={[
                styles.filterContainer,
                { backgroundColor: isDark ? '#181818' : 'white', shadowColor: isDark ? '#000' : '#000' }
            ]}>
                {['전체', '레귤러', '하이옥탄', '디젤'].map((type) => (
                    <TouchableOpacity
                        key={type}
                        onPress={() => {
                            setSelectedFuel(type);
                            setSelectedStation(null);
                            AsyncStorage.setItem('SELECTED_FUEL', type);
                        }}
                        style={[
                            styles.fuelButton,
                            selectedFuel === type && styles.fuelButtonSelected,
                            { backgroundColor: selectedFuel === type ? '#007AFF' : isDark ? '#282828' : '#f2f2f2' }
                        ]}
                    >
                        <Text style={{ color: selectedFuel === type ? '#fff' : (isDark ? '#fff' : '#000') }}>{type}</Text>
                    </TouchableOpacity>
                ))}

                <TouchableOpacity
                    onPress={() => setSortOrder((prev) => {
                        const next = prev === 'asc' ? 'desc' : prev === 'desc' ? null : 'asc';
                        if (next) {
                            AsyncStorage.setItem('SORT_ORDER', next);
                        } else {
                            AsyncStorage.removeItem('SORT_ORDER');
                        }
                        return next;
                    })}
                    style={[
                        styles.fuelButton,
                        sortOrder && styles.fuelButtonSelected,
                        { backgroundColor: sortOrder ? '#007AFF' : isDark ? '#282828' : '#f2f2f2' }
                    ]}
                >
                    <Text style={{ color: sortOrder ? '#fff' : (isDark ? '#fff' : '#000') }}>
                        {sortOrder === 'asc' ? '가격 ↑' : sortOrder === 'desc' ? '가격 ↓' : '가격'}
                    </Text>
                </TouchableOpacity>

                <TouchableOpacity
                    onPress={() => setShowOnlyFavorites((prev) => {
                        AsyncStorage.setItem('SHOW_ONLY_FAVORITES', (!prev).toString());
                        return !prev;
                    })}
                    style={[
                        styles.fuelButton,
                        showOnlyFavorites && styles.fuelButtonSelected,
                        { backgroundColor: showOnlyFavorites ? '#007AFF' : isDark ? '#282828' : '#f2f2f2' }
                    ]}
                >
                    <Text style={{ color: showOnlyFavorites ? '#fff' : (isDark ? '#fff' : '#000') }}>⭐ 즐겨찾기</Text>
                </TouchableOpacity>

                <TouchableOpacity
                    onPress={() => setFollowUserLocation((prev) => !prev)}
                    style={[
                        styles.fuelButton,
                        followUserLocation && styles.fuelButtonSelected,
                        { backgroundColor: followUserLocation ? '#007AFF' : isDark ? '#282828' : '#f2f2f2' }
                    ]}
                >
                    <Text style={{ color: followUserLocation ? '#fff' : (isDark ? '#fff' : '#000') }}>
                        {followUserLocation ? '따라가기 ON' : '따라가기 OFF'}
                    </Text>
                </TouchableOpacity>

                <TouchableOpacity
                    onPress={() => {
                        setSelectedFuel('전체');
                        setSelectedStation(null);
                        setSearchKeyword('');
                        setSortOrder(null);
                        setShowOnlyFavorites(false);
                        setFollowUserLocation(true);
                        AsyncStorage.multiRemove([
                            'SELECTED_FUEL',
                            'SORT_ORDER',
                            'SHOW_ONLY_FAVORITES',
                            'SEARCH_KEYWORD',
                        ]);
                    }}
                    style={[styles.fuelButton, { backgroundColor: isDark ? '#282828' : '#f2f2f2' }]}
                >
                    <Text style={{ color: isDark ? '#fff' : '#000' }}>초기화</Text>
                </TouchableOpacity>
            </View>

            <TextInput
                style={[
                    styles.searchInput,
                    {
                        backgroundColor: isDark ? '#222' : '#fff',
                        color: isDark ? '#fff' : '#000',
                        borderColor: isDark ? '#444' : '#ccc'
                    }
                ]}
                placeholder="주유소 이름 검색"
                placeholderTextColor={isDark ? '#aaa' : '#888'}
                value={searchKeyword}
                onChangeText={(text) => {
                    setSearchKeyword(text);
                    AsyncStorage.setItem('SEARCH_KEYWORD', text);
                    saveRecentSearch(text);
                }}
            />

            {searchKeyword.length > 0 && (
                <View style={{
                    position: 'absolute',
                    top: 150,
                    left: 20,
                    right: 20,
                    backgroundColor: isDark ? '#222' : '#fff',
                    borderRadius: 8,
                    padding: 6,
                    shadowColor: '#000',
                    shadowOpacity: 0.1,
                    shadowRadius: 4,
                    elevation: 3,
                }}>
                    {gasStations.filter(s => s.name.includes(searchKeyword)).slice(0, 5).map(s => (
                        <TouchableOpacity key={s.id} onPress={() => setSearchKeyword(s.name)} style={{ paddingVertical: 4 }}>
                            <Text style={{ color: isDark ? '#fff' : '#000' }}>{s.name}</Text>
                        </TouchableOpacity>
                    ))}
                </View>
            )}

            {recentSearches.length > 0 && (
                <View style={{ position: 'absolute', top: 160, left: 20, right: 20, flexDirection: 'row', flexWrap: 'wrap' }}>
                    {recentSearches.map((keyword: string) => (
                        <TouchableOpacity
                            key={keyword}
                            onPress={() => setSearchKeyword(keyword)}
                            style={{
                                backgroundColor: searchKeyword === keyword ? (isDark ? '#225577' : '#cce5ff') : (isDark ? '#222' : '#eee'),
                                paddingVertical: 4,
                                paddingHorizontal: 10,
                                borderRadius: 14,
                                marginRight: 6,
                                marginBottom: 6,
                                flexDirection: 'row',
                                alignItems: 'center',
                            }}
                        >
                            <Text style={{ marginRight: 6, color: isDark ? '#fff' : '#000' }}>{keyword}</Text>
                            <TouchableOpacity onPress={() => {
                                const updated = recentSearches.filter(k => k !== keyword);
                                setRecentSearches(updated);
                                AsyncStorage.setItem('RECENT_SEARCHES', JSON.stringify(updated));
                            }}>
                                <Text style={{ color: '#888' }}>✕</Text>
                            </TouchableOpacity>
                        </TouchableOpacity>
                    ))}
                </View>
            )}

            <Animated.View
                pointerEvents={selectedStation ? 'auto' : 'none'}
                style={[
                    styles.infoPanel,
                    {
                        backgroundColor: isDark ? '#181818' : '#fff',
                        transform: [
                            {
                                translateY: panelAnim.interpolate({
                                    inputRange: [0, 1],
                                    outputRange: [300, 0],
                                }),
                            },
                        ],
                        opacity: panelAnim,
                    },
                ]}
            >
                {selectedStation && (
                    <>
                        <Text style={[styles.infoTitle, { color: isDark ? '#fff' : '#000' }]}>{selectedStation.name}</Text>
                        <Text style={{ marginBottom: 4, color: isDark ? '#fff' : '#000' }}>
                            {selectedStation.fuelType} - ¥{selectedStation.price}
                        </Text>
                        {selectedStation.address && (
                            <Text style={{ fontSize: 13, color: isDark ? '#aaa' : '#666', marginBottom: 4 }}>
                                🏠 {selectedStation.address}
                            </Text>
                        )}
                        <Text style={{ fontSize: 13, color: isDark ? '#aaa' : '#666' }}>
                            📍 {(selectedStation.distance * 111).toFixed(2)} km 거리
                        </Text>
                        <TouchableOpacity
                            style={styles.directionsButton}
                            onPress={() =>
                                openGoogleMaps(
                                    selectedStation.latitude,
                                    selectedStation.longitude,
                                    selectedStation.name
                                )
                            }
                        >
                            <Text style={styles.directionsButtonText}>길찾기</Text>
                        </TouchableOpacity>
                        <TouchableOpacity onPress={() => toggleFavorite(selectedStation.id)}>
                            <Text style={{ textAlign: 'right', color: '#888', marginTop: 10 }}>
                                {favorites.includes(selectedStation.id) ? '⭐ 즐겨찾기 해제' : '☆ 즐겨찾기 추가'}
                            </Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                            onPress={() => {
                                setSelectedStation(null);
                                flatListRef.current?.scrollToOffset({ offset: 0, animated: true });
                            }}
                        >
                            <Text style={{ textAlign: 'right', color: '#888', marginTop: 10 }}>닫기</Text>
                        </TouchableOpacity>
                    </>
                )}
            </Animated.View>

            {/* Price Legend */}
            <View style={{
                position: 'absolute',
                bottom: 112,
                left: 12,
                right: 12,
                flexDirection: 'row',
                justifyContent: 'space-around',
            }}>
                <Text style={{ fontSize: 12, color: isDark ? '#fff' : '#000' }}>🟢 ¥150↓</Text>
                <Text style={{ fontSize: 12, color: isDark ? '#fff' : '#000' }}>🟠 ¥151~169</Text>
                <Text style={{ fontSize: 12, color: isDark ? '#fff' : '#000' }}>🔴 ¥170↑</Text>
            </View>
        </View>
    );
};

const styles = StyleSheet.create({
    container: { flex: 1 },
    map: { flex: 1 },
    filterContainer: {
        position: 'absolute',
        top: 50,
        left: 20,
        right: 20,
        flexDirection: 'row',
        justifyContent: 'space-around',
        backgroundColor: 'white',
        padding: 10,
        borderRadius: 8,
        shadowColor: '#000',
        shadowOpacity: 0.2,
        shadowRadius: 4,
        elevation: 5,
    },
    fuelButton: {
        paddingVertical: 6,
        paddingHorizontal: 12,
        backgroundColor: '#f2f2f2',
        borderRadius: 6,
        marginHorizontal: 4,
    },
    fuelButtonSelected: {
        backgroundColor: '#007AFF',
    },
    searchInput: {
        position: 'absolute',
        top: 110,
        left: 20,
        right: 20,
        backgroundColor: 'white',
        borderRadius: 8,
        paddingHorizontal: 12,
        paddingVertical: 8,
        shadowColor: '#000',
        shadowOpacity: 0.1,
        shadowRadius: 3,
        elevation: 3,
        borderWidth: 1,
        borderColor: '#ccc',
    },
    infoPanel: {
        position: 'absolute',
        bottom: 30,
        left: 20,
        right: 20,
        backgroundColor: '#fff',
        padding: 16,
        borderRadius: 10,
        shadowColor: '#000',
        shadowOpacity: 0.1,
        shadowRadius: 5,
        elevation: 5,
    },
    infoTitle: {
        fontSize: 16,
        fontWeight: 'bold',
        marginBottom: 4,
    },
    directionsButton: {
        marginTop: 10,
        backgroundColor: '#4A90E2',
        paddingVertical: 8,
        borderRadius: 6,
        alignItems: 'center',
    },
    directionsButtonText: {
        color: 'white',
        fontWeight: 'bold',
    },
    stationList: {
        position: 'absolute',
        bottom: 130,
        left: 0,
        right: 0,
        maxHeight: 180,
        backgroundColor: 'white',
    },
    stationItem: {
        padding: 16,
        borderBottomWidth: 0,
        backgroundColor: '#fff',
        borderRadius: 12,
        marginHorizontal: 12,
        marginVertical: 6,
        shadowColor: '#000',
        shadowOpacity: 0.05,
        shadowRadius: 3,
        elevation: 2,
    },
    stationItemSelected: {
        backgroundColor: '#e6f0ff',
        borderColor: '#007AFF',
        borderWidth: 1,
    },
    stationItemTitle: {
        fontWeight: 'bold',
        fontSize: 16,
        marginBottom: 2,
    },
    stationItemDistance: {
        color: '#4A90E2',
        fontSize: 13,
        fontWeight: '500',
    },
});

export default App;
