import { useEffect, useState } from 'react'
// import { supabase } from './lib/supabaseClient'
// import './App.css' TODO: import without erro.

function getLocation() {
  console.log("getLocation function called");
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(success, error);
  } else {
    console.log("Geolocation is not supported by this browser.");
  }
}

function success(position) {
  console.log("Latitude: " + position.coords.latitude + "Longitude: " + position.coords.longitude);
}

function error() {
  alert("Sorry, no position available.");
}


export default function Location() {
  return (
    <>
      <h1>Hello World</h1>
      <button onClick={getLocation}>Share My Location</button>
    </>
  );
}